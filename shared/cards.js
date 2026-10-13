'use strict';

/**
 * Surprise and Treasure card decks.
 *
 * Each card is pure data: an `id`, display `text`, and an `effect` object the
 * engine interprets. Keeping effects declarative means the engine has one
 * switch statement to test, and cards can be added without touching logic.
 *
 * Effect kinds:
 *   { kind: 'collect', amount }                 bank pays the player
 *   { kind: 'pay', amount }                     player pays the bank (feeds jackpot if enabled)
 *   { kind: 'collectFromEach', amount }         every other player pays the player
 *   { kind: 'payEach', amount }                 player pays every other player
 *   { kind: 'moveTo', tileId, collectGo }       advance to a tile; collect GO salary if passing
 *   { kind: 'moveBy', steps }                   move relative (negative = back), no GO salary going back
 *   { kind: 'nearest', tileType, rentMultiplier } advance to nearest airport/utility; special rent if owned
 *   { kind: 'goToJail' }                        straight to jail, no GO salary
 *   { kind: 'jailFree' }                        keep card; usable to leave jail
 *   { kind: 'repairs', perHouse, perHotel }     pay per building owned
 */

const SURPRISE_CARDS = Object.freeze([
  { id: 's-go',        text: 'Your startup got funded! Advance to GO and collect ₹200.', effect: { kind: 'moveTo', tileId: 'go', collectGo: true } },
  { id: 's-mumbai',    text: 'Business trip to Mumbai. Advance to Mumbai.', effect: { kind: 'moveTo', tileId: 'mumbai', collectGo: true } },
  { id: 's-chennai',   text: 'Filter coffee calls. Advance to Chennai. Collect ₹200 if you pass GO.', effect: { kind: 'moveTo', tileId: 'chennai', collectGo: true } },
  { id: 's-indore',    text: 'Street-food tour! Advance to Indore. Collect ₹200 if you pass GO.', effect: { kind: 'moveTo', tileId: 'indore', collectGo: true } },
  { id: 's-airport-1', text: 'Flight upgrade! Advance to the nearest airport. If owned, pay the owner double rent.', effect: { kind: 'nearest', tileType: 'airport', rentMultiplier: 2 } },
  { id: 's-airport-2', text: 'Missed your connection. Advance to the nearest airport. If owned, pay the owner double rent.', effect: { kind: 'nearest', tileType: 'airport', rentMultiplier: 2 } },
  { id: 's-utility',   text: 'Power cut! Advance to the nearest utility. If owned, roll and pay the owner 10× the dice.', effect: { kind: 'nearest', tileType: 'utility', rentMultiplier: 10 } },
  { id: 's-dividend',  text: 'Your mutual fund paid a dividend. Collect ₹50.', effect: { kind: 'collect', amount: 50 } },
  { id: 's-jailfree',  text: 'Good connections. Get out of Jail free. Keep this card until needed.', effect: { kind: 'jailFree' } },
  { id: 's-back3',     text: 'Wrong turn at the roundabout. Go back 3 spaces.', effect: { kind: 'moveBy', steps: -3 } },
  { id: 's-jail',      text: 'Caught jumping the signal. Go directly to Jail. Do not pass GO.', effect: { kind: 'goToJail' } },
  { id: 's-repairs',   text: 'Monsoon damage! Pay ₹25 per house and ₹100 per hotel.', effect: { kind: 'repairs', perHouse: 25, perHotel: 100 } },
  { id: 's-challan',   text: 'Traffic challan. Pay ₹15.', effect: { kind: 'pay', amount: 15 } },
  { id: 's-delhi-air', text: 'Take a flight from Delhi Airport. Collect ₹200 if you pass GO.', effect: { kind: 'moveTo', tileId: 'delhi-airport', collectGo: true } },
  { id: 's-chairman',  text: 'Elected society secretary. Pay each player ₹50.', effect: { kind: 'payEach', amount: 50 } },
  { id: 's-loan',      text: 'Your home loan was approved. Collect ₹150.', effect: { kind: 'collect', amount: 150 } },
]);

const TREASURE_CARDS = Object.freeze([
  { id: 't-go',        text: 'Diwali bonus! Advance to GO and collect ₹200.', effect: { kind: 'moveTo', tileId: 'go', collectGo: true } },
  { id: 't-bankerror', text: 'Bank error in your favour. Collect ₹200.', effect: { kind: 'collect', amount: 200 } },
  { id: 't-doctor',    text: 'Hospital bill. Pay ₹50.', effect: { kind: 'pay', amount: 50 } },
  { id: 't-shares',    text: 'You sold your shares at a profit. Collect ₹50.', effect: { kind: 'collect', amount: 50 } },
  { id: 't-jailfree',  text: 'Friend at the station. Get out of Jail free. Keep this card until needed.', effect: { kind: 'jailFree' } },
  { id: 't-jail',      text: 'Tax raid! Go directly to Jail. Do not pass GO.', effect: { kind: 'goToJail' } },
  { id: 't-fd',        text: 'Your fixed deposit matured. Collect ₹100.', effect: { kind: 'collect', amount: 100 } },
  { id: 't-refund',    text: 'Income tax refund. Collect ₹20.', effect: { kind: 'collect', amount: 20 } },
  { id: 't-birthday',  text: 'It is your birthday! Collect ₹10 from every player.', effect: { kind: 'collectFromEach', amount: 10 } },
  { id: 't-insurance', text: 'Life insurance matures. Collect ₹100.', effect: { kind: 'collect', amount: 100 } },
  { id: 't-fees',      text: 'College fees due. Pay ₹50.', effect: { kind: 'pay', amount: 50 } },
  { id: 't-consult',   text: 'Freelance consulting fee. Collect ₹25.', effect: { kind: 'collect', amount: 25 } },
  { id: 't-repairs',   text: 'Society maintenance. Pay ₹40 per house and ₹115 per hotel.', effect: { kind: 'repairs', perHouse: 40, perHotel: 115 } },
  { id: 't-contest',   text: 'Second prize in a rangoli contest. Collect ₹10.', effect: { kind: 'collect', amount: 10 } },
  { id: 't-inherit',   text: 'You inherit ₹100 from a distant relative.', effect: { kind: 'collect', amount: 100 } },
  { id: 't-wedding',   text: 'Cousin\'s wedding gift. Pay ₹100.', effect: { kind: 'pay', amount: 100 } },
]);

const DECKS = Object.freeze({
  surprise: SURPRISE_CARDS,
  treasure: TREASURE_CARDS,
});

function getCard(deck, id) {
  return DECKS[deck].find((c) => c.id === id);
}

module.exports = { SURPRISE_CARDS, TREASURE_CARDS, DECKS, getCard };
