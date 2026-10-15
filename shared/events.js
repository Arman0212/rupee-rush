/* UMD: CommonJS in Node (require), window.RR.events in the browser, no build step. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.RR = root.RR || {}).events = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

/**
 * World events for the optional "World events" mode.
 *
 * Like the cards, every event is pure data the engine interprets, so there's
 * one place to read and test them and no new branching logic per event. An
 * event changes only numbers the engine already computes — rent, house cost,
 * GO salary, taxes, trade fees — or triggers a single bank payment when it
 * starts. It never adds a turn phase.
 *
 * Two shapes of effect:
 *
 *   modifiers  stay in force while the event is active, read wherever the
 *              engine computes the matching number:
 *     rentMultiplier { groups?: string[], all?: true, factor }  scales rent
 *     airportRentFactor   number     scales airport rent (0 = no rent)
 *     utilityRentFactor   number     scales utility rent
 *     houseCostFactor     number     scales the cost to build a house/hotel
 *     goFactor            number     scales the GO salary
 *     taxFree             true       tax tiles charge nothing
 *     rentNoHouses        true       cities charge base rent; buildings ignored
 *     tradeFeeWaived      true       no transfer fee on mortgaged tiles in trades
 *     landBonus { groups, amount }   landing on one of these sets' cities pays
 *                                    the lander `amount` from the bank
 *
 *   onStart    a one-off applied the moment the event is drawn:
 *     { kind: 'eachPayFraction', fraction }  each player pays that share of
 *                                            their cash to the bank (never into debt)
 *     { kind: 'eachCollect', amount }        the bank pays each player
 *     { kind: 'eachPerBuilding', perHouse, perHotel }  each player pays the
 *                                            bank per building (never into debt)
 *     { kind: 'freeFromJail' }               everyone in jail walks free
 *     { kind: 'propertyShuffle' }            two unbuilt, unmortgaged tiles of
 *                                            different owners swap owners
 *
 *   rentReversal (modifier)  the owner pays the lander half the rent instead
 *
 * `chaosOnly: true` keeps an event out of the normal pool; it is drawn only
 * when the room has chaos events switched on.
 *
 * Country → colour group: Brazil brown, Israel lightBlue, Italy pink,
 * Germany orange, China red, France yellow, UK green, USA darkBlue.
 */

const EUROPE = Object.freeze(['pink', 'orange', 'yellow', 'green']); // Italy, Germany, France, UK

const EVENTS = Object.freeze([
  {
    id: 'tech-boom', name: 'Tech Boom', icon: '💻',
    text: 'Silicon surge: rent is doubled on all US and China cities.',
    modifiers: { rentMultiplier: { groups: ['darkBlue', 'red'], factor: 2 } },
  },
  {
    id: 'airport-strike', name: 'Airport Strike', icon: '🛫',
    text: 'Grounded: airports collect no rent.',
    modifiers: { airportRentFactor: 0 },
  },
  {
    id: 'housing-slump', name: 'Housing Slump', icon: '🏚️',
    text: 'Cheap materials: houses and hotels cost half as much to build.',
    modifiers: { houseCostFactor: 0.5 },
  },
  {
    id: 'tourist-season', name: 'Tourist Season', icon: '🧳',
    text: 'Crowds in Europe: land on any European city and the bank pays you ₹50.',
    modifiers: { landBonus: { groups: EUROPE, amount: 50 } },
  },
  {
    id: 'tax-holiday', name: 'Tax Holiday', icon: '🧾',
    text: 'A break for everyone: tax tiles charge nothing.',
    modifiers: { taxFree: true },
  },
  {
    id: 'market-crash', name: 'Market Crash', icon: '📉',
    text: 'Panic selling: every player pays 10% of their cash to the bank.',
    onStart: { kind: 'eachPayFraction', fraction: 0.1 },
  },
  {
    id: 'festival-bonus', name: 'Festival Bonus', icon: '🎆',
    text: 'Celebrations everywhere: GO pays double.',
    modifiers: { goFactor: 2 },
  },
  {
    id: 'rent-freeze', name: 'Rent Freeze', icon: '🧊',
    text: 'Regulators step in: cities charge base rent only; houses are ignored.',
    modifiers: { rentNoHouses: true },
  },
  {
    id: 'trade-fair', name: 'Trade Fair', icon: '🤝',
    text: 'Deals are in the air: trade transfer fees are waived.',
    modifiers: { tradeFeeWaived: true },
  },
  {
    id: 'bull-market', name: 'Bull Market', icon: '🐂',
    text: 'Boom times: all rent is increased by 50%.',
    modifiers: { rentMultiplier: { all: true, factor: 1.5 } },
  },
  {
    id: 'utility-surge', name: 'Utility Surge', icon: '⚡',
    text: 'Grid under strain: utilities charge double.',
    modifiers: { utilityRentFactor: 2 },
  },
  {
    id: 'jailbreak', name: 'Jailbreak', icon: '🔓',
    text: 'The gates swing open: everyone in jail walks free.',
    onStart: { kind: 'freeFromJail' },
  },
  {
    id: 'stimulus', name: 'Stimulus Cheque', icon: '💸',
    text: 'Relief payment: the bank pays every player ₹100.',
    onStart: { kind: 'eachCollect', amount: 100 },
  },
  {
    id: 'property-tax', name: 'Property Tax', icon: '🏠',
    text: 'Assessment year: every player pays ₹20 per house and ₹50 per hotel.',
    onStart: { kind: 'eachPerBuilding', perHouse: 20, perHotel: 50 },
  },
  {
    id: 'gold-rush', name: 'Gold Rush', icon: '🪙',
    text: 'Everyone wants to fly out: airport rent is doubled.',
    modifiers: { airportRentFactor: 2 },
  },
  {
    id: 'heatwave', name: 'Heatwave', icon: '☀️',
    text: 'Construction slows: houses and hotels cost 50% more to build.',
    modifiers: { houseCostFactor: 1.5 },
  },
  {
    id: 'homecoming', name: 'Homecoming', icon: '🎉',
    text: 'Everyone heads home: rent is doubled on all Brazil and Israel cities.',
    modifiers: { rentMultiplier: { groups: ['brown', 'lightBlue'], factor: 2 } },
  },
  // Chaos-only events: wilder effects, drawn only when chaos events are on.
  {
    id: 'rent-reversal', name: 'Rent Reversal', icon: '🔄', chaosOnly: true,
    text: 'Upside-down economy: the owner pays the lander half the rent.',
    modifiers: { rentReversal: true },
  },
  {
    id: 'property-shuffle', name: 'Property Shuffle', icon: '🔀', chaosOnly: true,
    text: 'Deeds in the air: two cities swap owners at random.',
    onStart: { kind: 'propertyShuffle' },
  },
  {
    id: 'boom-and-bust', name: 'Boom & Bust', icon: '🎢', chaosOnly: true,
    text: 'Wild swings: all rent is tripled this round.',
    modifiers: { rentMultiplier: { all: true, factor: 3 } },
  },
]);

const EVENT_BY_ID = Object.freeze(Object.fromEntries(EVENTS.map((e) => [e.id, e])));

function getEvent(id) {
  return EVENT_BY_ID[id] || null;
}

return { EVENTS, EVENT_BY_ID, getEvent };
});
