// The shared game data (board, cards, rules) is loaded as classic UMD scripts
// before any module runs, and exposed on window.RR. Re-export it for imports.
const RR = window.RR;
if (!RR || !RR.board || !RR.cards || !RR.rules) {
  throw new Error('Monopoly: shared data failed to load');
}

export const board = RR.board;
export const cards = RR.cards;
export const rules = RR.rules;
