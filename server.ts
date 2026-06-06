// Authoritative, conflict-free, and atomic financial/property transaction pipeline
app.post("/api/party/:code/transaction", (req, res) => {
  const code = req.params.code.toUpperCase();
  const room = rooms[code];
  if (!room) {
    return res.status(404).json({ error: "Party code not found" });
  }

  try {
    const { type } = req.body;
    const now = Date.now();
    const termId = `tx_${now}_${Math.random().toString(36).substr(2, 4)}`;
    let logEntry = null;

    if (type === "BUY_PROPERTY") {
      const { playerId, propertyId } = req.body;
      const player = room.players ? room.players[playerId] : null;
      const property = room.properties ? room.properties[propertyId] : null;

      if (!player || !property) {
        return res.status(400).json({ error: "Player or property not found in room state." });
      }
      if (player.inJail) {
        return res.status(400).json({ error: `${player.name} is in Jail and cannot purchase properties.` });
      }
      if (property.ownerId !== null) {
        return res.status(400).json({ error: `Deed for ${property.name} is already held by someone else.` });
      }
      if (player.cash < property.cost) {
        return res.status(400).json({ error: `${player.name} lacks £${property.cost} cash cards to purchase ${property.name}.` });
      }

      // Safe state updates
      player.cash -= property.cost;
      player.ownedPropertyIds = player.ownedPropertyIds || [];
      if (!player.ownedPropertyIds.includes(propertyId)) {
        player.ownedPropertyIds.push(propertyId);
      }
      property.ownerId = playerId;

      player.lastUpdated = now;
      property.lastUpdated = now;

      logEntry = {
        id: termId,
        type: 'PROPERTY_PURCHASE',
        description: `🏦 [Contactless Server] ${player.token || ''} ${player.name} bought ${property.name} from Bank for £${property.cost}.`,
        amount: property.cost,
        fromPlayerId: playerId,
        toPlayerId: null,
        timestamp: now
      };

    } else if (type === "PAY_RENT") {
      const { fromPlayerId, propertyId, amount } = req.body;
      const renter = room.players ? room.players[fromPlayerId] : null;
      const property = room.properties ? room.properties[propertyId] : null;

      if (!renter || !property || !property.ownerId) {
        return res.status(400).json({ error: "Renter, property, or owner not found." });
      }
      const owner = room.players[property.ownerId];
      if (!owner) {
        return res.status(400).json({ error: "Owner not found in players list." });
      }

      renter.cash -= amount;
      owner.cash += amount;

      if (renter.cash < 0) {
        renter.debtCreditorId = property.ownerId;
      }

      renter.lastUpdated = now;
      owner.lastUpdated = now;
      property.lastUpdated = now;

      logEntry = {
        id: termId,
        type: 'RENT_PAYMENT',
        description: `💷 [Contactless Server] ${renter.token || ''} ${renter.name} paid £${amount} rent to ${owner.name} at ${property.name}.`,
        amount: amount,
        fromPlayerId: fromPlayerId,
        toPlayerId: property.ownerId,
        timestamp: now
      };

    } else if (type === "BUILD_HOUSE") {
      const { playerId, propertyId } = req.body;
      const player = room.players ? room.players[playerId] : null;
      const property = room.properties ? room.properties[propertyId] : null;

      if (!player || !property) {
        return res.status(400).json({ error: "Player or property not found." });
      }
      if (property.ownerId !== playerId || property.isMortgaged) {
        return res.status(400).json({ error: "Property is mortgaged or not owned by player." });
      }
      if (player.cash < property.houseCost) {
        return res.status(400).json({ error: `${player.name} lacks £${property.houseCost} cash to construct on ${property.name}.` });
      }

      player.cash -= property.houseCost;
      property.housesCount = (property.housesCount || 0) + 1;

      player.lastUpdated = now;
      property.lastUpdated = now;

      const isHotel = property.housesCount === 5;
      const noun = isHotel ? 'Hotel' : 'House';
      logEntry = {
        id: termId,
        type: 'BUILD',
        description: `🏡 [Contactless Server] ${player.token || ''} ${player.name} constructed a ${noun} on ${property.name} for £${property.houseCost}.`,
        amount: property.houseCost,
        fromPlayerId: playerId,
        toPlayerId: null,
        timestamp: now
      };

    } else if (type === "SELL_HOUSE") {
      const { playerId, propertyId } = req.body;
      const player = room.players ? room.players[playerId] : null;
      const property = room.properties ? room.properties[propertyId] : null;

      if (!player || !property) {
        return res.status(400).json({ error: "Player or property not found." });
      }
      if (property.ownerId !== playerId || (property.housesCount || 0) <= 0) {
        return res.status(400).json({ error: "No houses to demolish or property not owned." });
      }

      const halfValue = Math.floor((property.houseCost || 100) / 2);
      player.cash += halfValue;
      property.housesCount = (property.housesCount || 0) - 1;

      player.lastUpdated = now;
      property.lastUpdated = now;

      const wasHotel = property.housesCount === 4;
      const noun = wasHotel ? 'Hotel' : 'House';
      logEntry = {
        id: termId,
        type: 'SELL',
        description: `🪓 [Contactless Server] ${player.token || ''} ${player.name} demolished a ${noun} on ${property.name} for refund of £${halfValue}.`,
        amount: halfValue,
        fromPlayerId: null,
        toPlayerId: playerId,
        timestamp: now
      };

    } else if (type === "TOGGLE_MORTGAGE") {
      const { playerId, propertyId } = req.body;
      const player = room.players ? room.players[playerId] : null;
      const property = room.properties ? room.properties[propertyId] : null;

      if (!player || !property) {
        return res.status(400).json({ error: "Player or property not found." });
      }
      if (property.ownerId !== playerId) {
        return res.status(400).json({ error: "Property is not owned by this player." });
      }

      if (!property.isMortgaged) {
        property.isMortgaged = true;
        player.cash += property.mortgageValue;
        logEntry = {
          id: termId,
          type: 'MORTGAGE',
          description: `🏦 [Contactless Server] ${player.token || ''} ${player.name} mortgaged ${property.name} for £${property.mortgageValue}.`,
          amount: property.mortgageValue,
          fromPlayerId: null,
          toPlayerId: playerId,
          timestamp: now
        };
      } else {
        const unmortgageCost = Math.ceil(property.mortgageValue * 1.1);
        if (player.cash < unmortgageCost) {
          return res.status(400).json({ error: `${player.name} lacks £${unmortgageCost} to unmortgage ${property.name}.` });
        }
        property.isMortgaged = false;
        player.cash -= unmortgageCost;
        logEntry = {
          id: termId,
          type: 'MORTGAGE',
          description: `💷 [Contactless Server] ${player.token || ''} ${player.name} unmortgaged ${property.name} for £${unmortgageCost}.`,
          amount: unmortgageCost,
          fromPlayerId: playerId,
          toPlayerId: null,
          timestamp: now
        };
      }

      player.lastUpdated = now;
      property.lastUpdated = now;

    } else if (type === "DECLARE_BANKRUPTCY") {
      const { debtorId, creditorId } = req.body;
      const debtor = room.players ? room.players[debtorId] : null;

      if (!debtor) {
        return res.status(400).json({ error: "Debtor profile not found." });
      }

      const debtorProperties = Object.values(room.properties || {}).filter((p: any) => p && p.ownerId === debtorId);
      const debtorPropIds = debtorProperties.map((p: any) => p.id);

      debtorPropIds.forEach((id: string) => {
        const p = room.properties[id];
        if (p) {
          p.ownerId = creditorId === "BANK" ? null : creditorId;
          p.housesCount = 0;
          if (creditorId === "BANK") {
            p.isMortgaged = false;
          }
          p.lastUpdated = now;
        }
      });

      const cashTransferred = debtor.cash > 0 ? debtor.cash : 0;
      if (creditorId !== "BANK") {
        const creditor = room.players ? room.players[creditorId] : null;
        if (creditor) {
          creditor.cash += cashTransferred;
          creditor.ownedPropertyIds = [...(creditor.ownedPropertyIds || []), ...debtorPropIds];
          creditor.lastUpdated = now;
        }
      }

      debtor.isBankrupt = true;
      debtor.cash = 0;
      debtor.ownedPropertyIds = [];
      debtor.debtCreditorId = null;
      debtor.lastUpdated = now;

      const creditorName = creditorId === "BANK" ? "the Bank" : (room.players[creditorId]?.name || creditorId);
      logEntry = {
        id: termId,
        type: 'BANKRUPTCY',
        description: `💀 [Contactless Server] ${debtor.token || ''} ${debtor.name} declared BANKRUPTCY to ${creditorName}. Asset transfer completed successfully.`,
        amount: cashTransferred,
        fromPlayerId: debtorId,
        toPlayerId: creditorId === "BANK" ? null : creditorId,
        timestamp: now
      };

    } else if (type === "TRANSFER_CASH") {
      const { fromPlayerId, toPlayerId, amount, narration } = req.body;
      const fromPlayer = room.players ? room.players[fromPlayerId] : null;

      if (!fromPlayer) {
        return res.status(400).json({ error: "Source player not found." });
      }

      if (toPlayerId === "BANK") {
        fromPlayer.cash -= amount;
        if (fromPlayer.cash < 0) {
          fromPlayer.debtCreditorId = "BANK";
        }
        fromPlayer.lastUpdated = now;
        logEntry = {
          id: termId,
          type: 'BANK_TRANSFER',
          description: narration || `💸 [Contactless Server] ${fromPlayer.token || ''} ${fromPlayer.name} paid £${amount} to the Bank.`,
          amount: amount,
          fromPlayerId: fromPlayerId,
          toPlayerId: null,
          timestamp: now
        };
      } else {
        const toPlayer = room.players ? room.players[toPlayerId] : null;
        if (!toPlayer) {
          return res.status(400).json({ error: "Recipient player not found." });
        }

        fromPlayer.cash -= amount;
        toPlayer.cash += amount;

        if (fromPlayer.cash < 0) {
          fromPlayer.debtCreditorId = toPlayerId;
        }
        fromPlayer.lastUpdated = now;
        toPlayer.lastUpdated = now;
        logEntry = {
          id: termId,
          type: 'PEER_TRANSFER',
          description: narration || `💸 [Contactless Server] ${fromPlayer.token || ''} ${fromPlayer.name} transferred £${amount} to ${toPlayer.name}.`,
          amount: amount,
          fromPlayerId: fromPlayerId,
          toPlayerId: toPlayerId,
          timestamp: now
        };
      }

    } else if (type === "BANK_ADJUST") {
      const { playerId, amount, adjustType } = req.body;
      const player = room.players ? room.players[playerId] : null;
      if (!player) {
        return res.status(400).json({ error: "Player not found." });
      }

      if (adjustType === 'GO') {
        player.cash += 200;
        player.lastUpdated = now;
        logEntry = {
          id: termId,
          type: 'PASS_GO',
          description: `⛲ [Contactless Server] ${player.token || ''} ${player.name} passed GO and collected salary of £200.`,
          amount: 200,
          fromPlayerId: null,
          toPlayerId: playerId,
          timestamp: now
        };
      } else if (adjustType === 'INCOME_TAX') {
        player.cash -= 200;
        if (player.cash < 0) {
          player.debtCreditorId = 'BANK';
        }
        player.lastUpdated = now;
        logEntry = {
          id: termId,
          type: 'BANK_TRANSFER',
          description: `⚖️ [Contactless Server] ${player.token || ''} ${player.name} paid Income Tax of £200.`,
          amount: 200,
          fromPlayerId: playerId,
          toPlayerId: null,
          timestamp: now
        };
      } else if (adjustType === 'SUPER_TAX') {
        player.cash -= 100;
        if (player.cash < 0) {
          player.debtCreditorId = 'BANK';
        }
        player.lastUpdated = now;
        logEntry = {
          id: termId,
          type: 'BANK_TRANSFER',
          description: `⚖️ [Contactless Server] ${player.token || ''} ${player.name} paid Super Tax of £100.`,
          amount: 100,
          fromPlayerId: playerId,
          toPlayerId: null,
          timestamp: now
        };
      } else if (adjustType === 'TAX') {
        player.cash -= 150;
        if (player.cash < 0) {
          player.debtCreditorId = 'BANK';
        }
        player.lastUpdated = now;
        logEntry = {
          id: termId,
          type: 'BANK_TRANSFER',
          description: `⚖️ [Contactless Server] ${player.token || ''} ${player.name} paid automated government luxury and property taxes of £150.`,
          amount: 150,
          fromPlayerId: playerId,
          toPlayerId: null,
          timestamp: now
        };
      } else if (adjustType === 'CUSTOM') {
        player.cash += amount;
        if (player.cash < 0) {
          player.debtCreditorId = 'BANK';
        } else {
          player.debtCreditorId = null;
        }
        player.lastUpdated = now;
        logEntry = {
          id: termId,
          type: 'MANUAL_CASH_ADJUST',
          description: `🏦 [Contactless Server] Banker manual audit adjust: transferred £${amount} cash balance for ${player.name}.`,
          amount: Math.abs(amount),
          fromPlayerId: amount < 0 ? playerId : null,
          toPlayerId: amount > 0 ? playerId : null,
          timestamp: now
        };
      }

    } else if (type === "PROCESS_CARD") {
      const { playerId, cardId } = req.body;
      const player = room.players ? room.players[playerId] : null;
      const card = cardLookupData[cardId];

      if (!player || !card) {
        return res.status(400).json({ error: "Player or Card lookup failed." });
      }

      if (card.actionType === 'ADD_CASH') {
        player.cash += card.amount;
        player.lastUpdated = now;
        logEntry = {
          id: termId,
          type: 'DRAW_CARD',
          description: `📦 [Contactless Server] ${player.token || ''} ${player.name} drew: "${card.description}" -> Credit +£${card.amount}.`,
          amount: card.amount,
          fromPlayerId: null,
          toPlayerId: playerId,
          timestamp: now
        };
      } else if (card.actionType === 'DEDUCT_CASH') {
        player.cash -= card.amount;
        if (player.cash < 0) {
          player.debtCreditorId = 'BANK';
        }
        player.lastUpdated = now;
        logEntry = {
          id: termId,
          type: 'DRAW_CARD',
          description: `📦 [Contactless Server] ${player.token || ''} ${player.name} drew: "${card.description}" -> Fine -£${card.amount}.`,
          amount: card.amount,
          fromPlayerId: playerId,
          toPlayerId: null,
          timestamp: now
        };
      } else if (card.actionType === 'COLLECT_FROM_PLAYERS') {
        const keys = Object.keys(room.players).filter(id => !room.players[id].isBankrupt);
        const countOtherPlayers = keys.filter(id => id !== playerId).length;
        if (countOtherPlayers > 0) {
          player.cash += card.amount * countOtherPlayers;
          player.lastUpdated = now;
          keys.forEach(id => {
            if (id !== playerId) {
              const other = room.players[id];
              other.cash -= card.amount;
              if (other.cash < 0) {
                other.debtCreditorId = playerId;
              }
              other.lastUpdated = now;
            }
          });
        }
        logEntry = {
          id: termId,
          type: 'DRAW_CARD',
          description: `📦 [Contactless Server] ${player.token || ''} ${player.name} drew: "${card.description}" -> Collected £${card.amount} from each player.`,
          amount: card.amount,
          fromPlayerId: null,
          toPlayerId: playerId,
          timestamp: now
        };
      } else if (card.actionType === 'JAIL_FREE') {
        player.jailFreeCards = (player.jailFreeCards || 0) + 1;
        player.lastUpdated = now;
        logEntry = {
          id: termId,
          type: 'DRAW_CARD',
          description: `🎟️ [Contactless Server] ${player.token || ''} ${player.name} drew: "${card.description}" -> Locked Escape card.`,
          amount: 0,
          fromPlayerId: null,
          toPlayerId: null,
          timestamp: now
        };
      } else if (card.actionType === 'GO_TO_JAIL') {
        player.inJail = true;
        player.jailTurns = 0;
        player.lastUpdated = now;
        logEntry = {
          id: termId,
          type: 'DRAW_CARD',
          description: `🚨 [Contactless Server] ${player.token || ''} ${player.name} sent to Jail!`,
          amount: 0,
          fromPlayerId: null,
          toPlayerId: null,
          timestamp: now
        };
      } else {
        logEntry = {
          id: termId,
          type: 'DRAW_CARD',
          description: `ℹ️ [Contactless Server] ${player.token || ''} ${player.name} drew: "${card.description}"`,
          amount: 0,
          fromPlayerId: null,
          toPlayerId: null,
          timestamp: now
        };
      }

    } else if (type === "ESCAPE_JAIL") {
      const { playerId, method } = req.body;
      const player = room.players ? room.players[playerId] : null;
      if (!player) {
        return res.status(400).json({ error: "Player not found." });
      }

      if (method === 'CARD') {
        player.jailFreeCards = Math.max(0, (player.jailFreeCards || 0) - 1);
        player.inJail = false;
        player.jailTurns = 0;
        player.lastUpdated = now;
        logEntry = {
          id: termId,
          type: 'JAIL_ESCAPE',
          description: `🎟️ [Contactless Server] ${player.token || ''} ${player.name} used a Get Out of Jail Free card!`,
          amount: 0,
          fromPlayerId: null,
          toPlayerId: null,
          timestamp: now
        };
      } else if (method === 'FINE') {
        player.cash -= 50;
        player.inJail = false;
        player.jailTurns = 0;
        player.lastUpdated = now;
        logEntry = {
          id: termId,
          type: 'JAIL_FINE',
          description: `💷 [Contactless Server] ${player.token || ''} ${player.name} settled £50 jail release invoice fine.`,
          amount: 50,
          fromPlayerId: playerId,
          toPlayerId: null,
          timestamp: now
        };
      }

    } else if (type === "EXECUTE_TRADE") {
      const { buyerId, sellerId, propertyId, price } = req.body;
      const buyer = room.players ? room.players[buyerId] : null;
      const seller = room.players ? room.players[sellerId] : null;
      const property = room.properties ? room.properties[propertyId] : null;

      if (!buyer || !seller || !property) {
        return res.status(400).json({ error: "Buyer, seller, or property title not found." });
      }
      if (buyer.cash < price) {
        return res.status(400).json({ error: `${buyer.name} possesses insufficient cash (£${buyer.cash}) to complete trade for £${price}.` });
      }

      buyer.cash -= price;
      seller.cash += price;

      seller.ownedPropertyIds = (seller.ownedPropertyIds || []).filter((id: string) => id !== propertyId);
      buyer.ownedPropertyIds = buyer.ownedPropertyIds || [];
      if (!buyer.ownedPropertyIds.includes(propertyId)) {
        buyer.ownedPropertyIds.push(propertyId);
      }
      property.ownerId = buyerId;

      buyer.lastUpdated = now;
      seller.lastUpdated = now;
      property.lastUpdated = now;

      logEntry = {
        id: termId,
        type: 'TRADE',
        description: `🤝 [Contactless Server] ${buyer.token || ''} ${buyer.name} bought property title ${property.name} from ${seller.name} for £${price}.`,
        amount: price,
        fromPlayerId: buyerId,
        toPlayerId: sellerId,
        timestamp: now
      };

    } else if (type === "ACCEPT_TRADE_REQUEST") {
      const { reqId } = req.body;
      const tradeReq = (room.tradeRequests || []).find((r: any) => r.id === reqId);
      if (!tradeReq) {
        return res.status(400).json({ error: "Trade proposal not found." });
      }

      const playerA = room.players ? room.players[tradeReq.fromPlayerId] : null;
      const playerB = room.players ? room.players[tradeReq.toPlayerId] : null;

      if (!playerA || !playerB) {
        return res.status(400).json({ error: "Players in trade proposal not found in room state." });
      }

      if (playerA.cash < tradeReq.cashFromA) {
        return res.status(400).json({ error: `${playerA.name} lacks £${tradeReq.cashFromA} to fulfill trade.` });
      }
      if (playerB.cash < tradeReq.cashFromB) {
        return res.status(400).json({ error: `${playerB.name} lacks £${tradeReq.cashFromB} to fulfill trade.` });
      }

      // Cash exchange
      playerA.cash = playerA.cash - tradeReq.cashFromA + tradeReq.cashFromB;
      playerB.cash = playerB.cash - tradeReq.cashFromB + tradeReq.cashFromA;

      // Jail cards exchange
      playerA.jailFreeCards = (playerA.jailFreeCards || 0) - tradeReq.jailCardsFromA + tradeReq.jailCardsFromB;
      playerB.jailFreeCards = (playerB.jailFreeCards || 0) - tradeReq.jailCardsFromB + tradeReq.jailCardsFromA;

      // Properties transfer
      playerA.ownedPropertyIds = (playerA.ownedPropertyIds || []).filter((id: string) => !tradeReq.propertiesFromA.includes(id));
      playerB.ownedPropertyIds = (playerB.ownedPropertyIds || []).filter((id: string) => !tradeReq.propertiesFromB.includes(id));

      tradeReq.propertiesFromA.forEach((pid: string) => {
        playerB.ownedPropertyIds.push(pid);
        if (room.properties[pid]) {
          room.properties[pid].ownerId = tradeReq.toPlayerId;
          room.properties[pid].lastUpdated = now;
        }
      });

      tradeReq.propertiesFromB.forEach((pid: string) => {
        playerA.ownedPropertyIds.push(pid);
        if (room.properties[pid]) {
          room.properties[pid].ownerId = tradeReq.fromPlayerId;
          room.properties[pid].lastUpdated = now;
        }
      });

      // Set status
      tradeReq.status = "ACCEPTED";
      tradeReq.timestamp = now;

      // Auto-decline overlapping pending requests
      const involvedProperties = [...tradeReq.propertiesFromA, ...tradeReq.propertiesFromB];
      room.tradeRequests.forEach((r: any) => {
        if (r.id !== reqId && r.status === 'PENDING') {
          const overlap = r.propertiesFromA.some((p: string) => involvedProperties.includes(p)) ||
                          r.propertiesFromB.some((p: string) => involvedProperties.includes(p));
          if (overlap) {
            r.status = 'DECLINED';
            r.timestamp = now;
          }
        }
      });

      playerA.lastUpdated = now;
      playerB.lastUpdated = now;

      logEntry = {
        id: termId,
        type: 'TRADE',
        description: `🤝 [Contactless Server] ${playerA.token} ${playerA.name} and ${playerB.token} ${playerB.name} finalized mutually approved peer trade contract.`,
        amount: 0,
        fromPlayerId: tradeReq.fromPlayerId,
        toPlayerId: tradeReq.toPlayerId,
        timestamp: now
      };

    } else {
      return res.status(400).json({ error: `Unsupported transaction type: ${type}` });
    }

    if (logEntry) {
      room.history = [logEntry, ...(room.history || [])];
      if (room.history.length > 150) {
        room.history = room.history.slice(0, 150); // limit ledger size
      }
    }

    room.timestamp = now;
    return res.json(room);

  } catch (err: any) {
    console.error("[Transaction Error]", err);
    return res.status(500).json({ error: `Internal transaction execution failure: ${err.message}` });
  }
});
