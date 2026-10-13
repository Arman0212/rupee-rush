// "How to play": a short, friendly guide in a dialog.
import { rules } from '../shared.js';
import { el } from '../dom.js';
import { openDialog } from './modal.js';

const SECTIONS = [
  ['The goal', 'Be the last player standing. Everyone else runs out of money and goes bankrupt; you keep trading, building and collecting rent.'],
  ['Your turn', 'Roll two dice and move. Doubles let you roll again, but three doubles in one turn send you straight to jail. Passing GO pays your salary.'],
  ['Buying', "Land on an unowned city, airport or utility and you can buy it at its list price. Pass on it and everyone (you included) can bid for it in a quick auction. Each bid restarts the clock; when it runs out, the highest bid wins."],
  ['Rent', 'Anyone landing on your property pays you rent. Own a whole colour set and empty cities charge double. Airports pay more the more of them you own, and utilities charge a multiple of the dice roll.'],
  ['Building', 'With a full colour set you can build houses, then a hotel. Build evenly: no city can be more than one house ahead of the others in its set. Rent jumps with every house.'],
  ['Jail', "On your turn in jail you can pay the ₹50 fine, use a jail-free card, or try for doubles. After three misses you pay and move. You still collect rent while you're inside."],
  ['Money trouble', "If you can't pay, you go into debt and must sell buildings or mortgage cities before you can roll or end your turn. A mortgaged city earns no rent until you buy it back for its mortgage value plus 10%. If nothing can cover the debt, declare bankruptcy."],
  ['Trading', 'Open the Trades tab to offer cities, cash and jail-free cards to another player. They can accept, decline or counter. Cities in a set with buildings can\'t be traded until the buildings are sold, and taking over a mortgaged city costs a 10% fee.'],
  ['Cards and corners', 'Surprise and Treasure cards can pay you, fine you, or move you around. Taxes are paid to the bank, unless the host turned on the Vacation jackpot: then they pile up and whoever lands on Vacation takes the lot.'],
  ['Shortcuts', 'On a keyboard: R rolls, B buys, E ends your turn. Click any tile for its rent table.'],
];

export function openHelp() {
  const handle = openDialog({
    className: 'dialog-help',
    label: 'How to play',
    content: [
      el('p', { className: 'eyebrow', text: 'How to play' }),
      el('h2', { className: 'dialog-title', text: `${rules.GAME_NAME} in two minutes` }),
      el('div', { className: 'help-sections' }, SECTIONS.map(([title, text]) => el('section', { className: 'help-section' },
        el('h3', { text: title }),
        el('p', { text })))),
      el('div', { className: 'dialog-actions' }, el('button', { className: 'btn btn-primary', type: 'button', text: 'Got it', on: { click: () => handle.close() } })),
    ],
  });
  return handle;
}
