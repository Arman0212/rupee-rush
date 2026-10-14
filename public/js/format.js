// Names, money and human-readable labels for actions and events.
import { board, rules } from './shared.js';

const { getTileById, COLOR_GROUPS, MAX_BUILDINGS } = board;
const { JAIL, BUILDING, unmortgageCost, formatRupees } = rules;

export const money = (amount) => formatRupees(amount);
export const tileName = (id) => (getTileById(id) || { name: id }).name;
export const groupName = (group) => (COLOR_GROUPS[group] ? COLOR_GROUPS[group].name : group === 'airport' ? 'Airports' : 'Utilities');
export const sellRefund = (tile) => Math.round(tile.houseCost * BUILDING.sellBackRatio);
/**
 * Style for a player-coloured disc: the colour plus whichever ink (white or
 * dark) has the higher WCAG contrast on it, so initials stay readable on
 * light colours like mustard or sky blue.
 */
export function tokenStyle(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  const lin = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  const DARK_LUM = 0.016; // --ink #2b2118
  const onWhite = 1.05 / (lum + 0.05);
  const onDark = (lum + 0.05) / (DARK_LUM + 0.05);
  return { '--token': hex, '--token-ink': onDark > onWhite ? '#2b2118' : '#ffffff' };
}

export const initial = (name) => ([...String(name || '?').trim()][0] || '?').toUpperCase();

/** Look up a player's name across the room seats and the game (kicked players only exist in the game). */
export function nameLookup(state) {
  const names = new Map();
  for (const p of (state && state.publicState && state.publicState.players) || []) names.set(p.id, p.name);
  for (const p of (state && state.room && state.room.players) || []) names.set(p.id, p.name);
  return (id) => {
    if (id === null || id === undefined) return 'the bank';
    if (id === 'jackpot') return 'the jackpot';
    return names.get(id) || 'someone';
  };
}

/** Rough value of one side of a trade: tile prices (half if mortgaged), cash, ₹50 per jail-free card. */
export function offerValue(side, properties) {
  const tiles = side.tileIds.reduce((t, id) => t + (properties[id].mortgaged ? getTileById(id).price / 2 : getTileById(id).price), 0);
  return tiles + side.cash + side.jailCards.length * 50;
}

/** "Patna, Goa + ₹100 + 1 jail-free card" */
export function describeSide(side) {
  const parts = side.tileIds.map(tileName);
  if (side.cash) parts.push(money(side.cash));
  if (side.jailCards.length) parts.push(`${side.jailCards.length} jail-free card${side.jailCards.length > 1 ? 's' : ''}`);
  return parts.length ? parts.join(', ') : 'nothing';
}


export const buildingWord = (n) => (n >= MAX_BUILDINGS ? 'a hotel' : n === 1 ? '1 house' : `${n} houses`);

// ---------------------------------------------------------------------------
// Action labels
// ---------------------------------------------------------------------------

/** Full label for an action button, e.g. "Buy Jaipur for ₹120". */
export function actionLabel(action, { publicState, me }) {
  const tile = action.tileId ? getTileById(action.tileId) : null;
  const prop = tile && publicState ? publicState.properties[tile.id] : null;
  switch (action.type) {
    case 'roll':
      if (me && me.inJail) return 'Roll for doubles';
      return publicState && publicState.turn.dice ? 'Roll again' : 'Roll dice';
    case 'buy': {
      const pending = publicState && getTileById(publicState.turn.pendingTileId);
      return pending ? `Buy ${pending.name} for ${money(pending.price)}` : 'Buy';
    }
    case 'decline': {
      const pending = publicState && publicState.turn.pendingTileId;
      return pending ? `Don't buy ${tileName(pending)}` : "Don't buy";
    }
    case 'endTurn': return 'End turn';
    case 'payJailFine': return `Pay ${money(JAIL.fine)} fine`;
    case 'useJailCard': return 'Use get-out-of-jail card';
    case 'bankrupt': return 'Declare bankruptcy';
    case 'bid': return `Bid ${money(action.amount)}`;
    case 'pass': return 'Pass';
    case 'acceptTrade': return 'Accept';
    case 'declineTrade': return 'Decline';
    case 'counterTrade': return 'Counter';
    case 'cancelTrade': return 'Cancel offer';
    case 'build':
      return prop && prop.buildings === MAX_BUILDINGS - 1
        ? `Build a hotel on ${tile.name} (${money(tile.houseCost)})`
        : `Build a house on ${tile.name} (${money(tile.houseCost)})`;
    case 'sellHouse':
      return `Sell ${prop && prop.buildings === MAX_BUILDINGS ? 'the hotel' : 'a house'} on ${tile.name} (+${money(sellRefund(tile))})`;
    case 'mortgage': return `Mortgage ${tile.name} (+${money(tile.mortgageValue)})`;
    case 'unmortgage': return `Unmortgage ${tile.name} (${money(unmortgageCost(tile.price))})`;
    default: return action.type;
  }
}

/** Compact label for the per-city quick buttons. */
export function shortActionLabel(action, { publicState }) {
  const tile = getTileById(action.tileId);
  const prop = publicState.properties[tile.id];
  switch (action.type) {
    case 'build': return prop.buildings === MAX_BUILDINGS - 1 ? `+Hotel ${money(tile.houseCost)}` : `+House ${money(tile.houseCost)}`;
    case 'sellHouse': return `Sell +${money(sellRefund(tile))}`;
    case 'mortgage': return `Mortgage +${money(tile.mortgageValue)}`;
    case 'unmortgage': return `Unmortgage ${money(unmortgageCost(tile.price))}`;
    default: return action.type;
  }
}

// ---------------------------------------------------------------------------
// Event descriptions for the log
// ---------------------------------------------------------------------------

const JAIL_EXIT = { fine: 'paid the fine', card: 'used a jail-free card', doubles: 'rolled doubles', forced: 'paid the fine after three tries' };
const SEAT_LEFT = { left: 'left the room', kicked: 'was removed by the host', removed: 'was removed by the host', timeout: 'timed out' };

/** One line for the event log, or null for events that aren't worth showing. */
export function describeEvent(e, name) {
  const t = (id) => tileName(id);
  switch (e.type) {
    case 'gameStarted': return 'The game has begun. Good luck!';
    case 'turnStarted': return `${name(e.playerId)}'s turn.`;
    case 'diceRolled':
      return e.reason === 'utilityCard'
        ? `${name(e.playerId)} rolled ${e.dice[0]} + ${e.dice[1]} for the utility bill.`
        : `${name(e.playerId)} rolled ${e.dice[0]} + ${e.dice[1]}${e.doubles ? ' (doubles!)' : ''}.`;
    case 'moved': return `${name(e.playerId)} landed on ${board.BOARD[e.to].name}${e.passedGo ? ', passing GO' : ''}.`;
    case 'moneyCollected':
      if (e.reason === 'startingCash') return null;
      if (e.reason === 'goSalary') return `${name(e.to)} collected ${money(e.amount)} salary.`;
      return `${name(e.to)} collected ${money(e.amount)}.`;
    case 'moneyPaid':
      if (e.reason === 'jailFine') return `${name(e.from)} paid the ${money(e.amount)} jail fine.`;
      if (e.reason === 'bankruptcy') return `${name(e.from)} handed ${money(e.amount)} to ${name(e.to)}.`;
      if (e.to === null) return `${name(e.from)} paid ${money(e.amount)} to the bank.`;
      if (e.to === 'jackpot') return `${name(e.from)} paid ${money(e.amount)} into the jackpot.`;
      return `${name(e.from)} paid ${name(e.to)} ${money(e.amount)}.`;
    case 'rentPaid': return `${name(e.from)} paid ${name(e.to)} ${money(e.amount)} rent for ${t(e.tileId)}.`;
    case 'rentWaived': return `No rent on ${t(e.tileId)}: ${e.reason === 'mortgaged' ? "it's mortgaged" : 'the owner is in jail'}.`;
    case 'taxPaid': return `${name(e.from)} paid ${money(e.amount)} ${t(e.tileId)}${e.to === 'jackpot' ? ' into the jackpot' : ''}.`;
    case 'jackpotCollected': return `${name(e.to)} won the ${money(e.amount)} jackpot!`;
    case 'propertyBought': return `${name(e.from)} bought ${t(e.tileId)} for ${money(e.amount)}.`;
    case 'purchaseDeclined': return `${name(e.playerId)} passed on ${t(e.tileId)}.`;
    case 'built': return `${name(e.from)} built on ${t(e.tileId)}: now ${buildingWord(e.buildings)}.`;
    case 'houseSold': return `${name(e.to)} sold a building on ${t(e.tileId)} for ${money(e.amount)}.`;
    case 'mortgaged': return `${name(e.to)} mortgaged ${t(e.tileId)} for ${money(e.amount)}.`;
    case 'unmortgaged': return `${name(e.from)} paid off the mortgage on ${t(e.tileId)}.`;
    case 'cardDrawn': return `${name(e.playerId)} drew ${e.deck === 'surprise' ? 'Surprise' : 'Treasure'}: “${e.text}”`;
    case 'sentToJail': return `${name(e.playerId)} went to jail${e.reason === 'tripleDoubles' ? ' for rolling three doubles' : ''}.`;
    case 'leftJail': return `${name(e.playerId)} left jail (${JAIL_EXIT[e.method] || e.method}).`;
    case 'jailRollFailed': return `${name(e.playerId)} stays in jail (try ${e.attempt} of 3).`;
    case 'debtIncurred': return `${name(e.from)} now owes ${name(e.to)} ${money(e.amount)}.`;
    case 'debtPaid': return `${name(e.from)} paid ${money(e.amount)} of their debt to ${name(e.to)}.`;
    case 'debtCleared': return `${name(e.playerId)} is out of debt.`;
    case 'debtForgiven': return `${name(e.from)}'s ${money(e.amount)} debt to ${name(e.to)} was cancelled.`;
    case 'propertyTransferred': return `${t(e.tileId)} passed to ${name(e.to)}.`;
    case 'propertyReturned': return `${t(e.tileId)} went back to the bank.`;
    case 'bankrupt': return `${name(e.playerId)} went bankrupt${e.creditorId ? ` to ${name(e.creditorId)}` : ''}.`;
    case 'gameOver': return e.winnerId ? `${name(e.winnerId)} wins the game!` : 'Game over.';
    case 'playerLeft': return `${name(e.playerId)} left the game.`;
    case 'seatJoined': return e.bot ? `${e.name} (${e.bot} bot) joined the room.` : `${e.name} joined the room.`;
    case 'seatReplacedByBot': return `A ${e.difficulty} bot took over for ${name(e.playerId)}.`;
    case 'seatLeft': return `${name(e.playerId)} ${SEAT_LEFT[e.reason] || 'left'}.`;
    case 'seatDisconnected': return `${name(e.playerId)} lost connection.`;
    case 'seatReconnected': return `${name(e.playerId)} is back.`;
    case 'hostChanged': return `${name(e.playerId)} is now the host.`;
    case 'settingsChanged': return 'The host updated the settings.';
    case 'backToLobby': return 'Back to the lobby for another game.';
    case 'turnTimedOut': return `${name(e.playerId)} ran out of time.`;
    case 'auctionStarted': return `${t(e.tileId)} is up for auction!`;
    case 'bidPlaced': return `${name(e.playerId)} bid ${money(e.amount)}`;
    case 'auctionPassed': return `${name(e.playerId)} passed.`;
    case 'auctionClosed': return e.winnerId ? `${name(e.winnerId)} won ${t(e.tileId)} for ${money(e.amount)}.` : `Nobody bid on ${t(e.tileId)}; it stays with the bank.`;
    case 'tradeProposed': return `${name(e.fromId)} offered ${name(e.toId)} a trade.`;
    case 'tradeAccepted': return `${name(e.toId)} accepted ${name(e.fromId)}'s trade.`;
    case 'tradeDeclined': return `${name(e.toId)} ${e.countered ? 'countered' : 'declined'} ${name(e.fromId)}'s trade.`;
    case 'tradeCancelled': return e.reason === 'withdrawn'
      ? `${name(e.fromId)} withdrew their offer to ${name(e.toId)}.`
      : `A trade between ${name(e.fromId)} and ${name(e.toId)} was cancelled: ${e.reason}.`;
    case 'tradePayment': return null; // covered by tradeAccepted
    case 'mortgageFee': return `${name(e.from)} paid a ${money(e.amount)} fee on mortgaged ${t(e.tileId)}.`;
    default: return null;
  }
}
