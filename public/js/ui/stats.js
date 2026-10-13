// End-of-game stats: net worth over the game as a small inline SVG line chart
// (no library), plus the most-landed tile and the biggest rent paid.
import { board } from '../shared.js';
import { el } from '../dom.js';
import { money, tileName, nameLookup } from '../format.js';

const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
};

/** A line per player: x = turn, y = net worth. */
function worthChart(stats, players) {
  const points = stats.worth;
  const W = 400;
  const H = 160;
  const PAD = { left: 44, right: 8, top: 8, bottom: 22 };
  const maxTurn = Math.max(1, points[points.length - 1].turnNumber);
  const maxWorth = Math.max(1, ...points.flatMap((p) => p.worth));
  const x = (turn) => PAD.left + (turn / maxTurn) * (W - PAD.left - PAD.right);
  const y = (worth) => H - PAD.bottom - (worth / maxWorth) * (H - PAD.top - PAD.bottom);

  const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'worth-chart', role: 'img' });
  const title = svg('title');
  title.textContent = `Net worth over ${maxTurn} turns: ${players.map((p, i) => `${p.name} ended at ${money(points[points.length - 1].worth[i])}`).join(', ')}`;
  chart.append(title);
  // Axes and a few gridlines.
  for (const frac of [0, 0.5, 1]) {
    const gy = y(maxWorth * frac);
    chart.append(svg('line', { x1: PAD.left, x2: W - PAD.right, y1: gy, y2: gy, class: 'grid' }));
    const label = svg('text', { x: PAD.left - 6, y: gy + 4, 'text-anchor': 'end', class: 'axis' });
    label.textContent = money(Math.round(maxWorth * frac));
    chart.append(label);
  }
  const turns = svg('text', { x: W - PAD.right, y: H - 4, 'text-anchor': 'end', class: 'axis' });
  turns.textContent = `turn ${maxTurn}`;
  chart.append(turns);
  players.forEach((p, i) => {
    const d = points.map((pt, j) => `${j ? 'L' : 'M'}${x(pt.turnNumber).toFixed(1)},${y(pt.worth[i]).toFixed(1)}`).join(' ');
    chart.append(svg('path', { d, class: 'worth-line', stroke: p.color }));
  });
  return chart;
}

/** The stats block for the game-over dialog, or null if there's nothing to show. */
export function statsBlock(publicState, state) {
  const stats = publicState.stats;
  if (!stats || !stats.worth.length) return null;
  const name = nameLookup(state);
  const landings = stats.landings;
  const top = landings.indexOf(Math.max(...landings));
  const rent = stats.biggestRent;
  const legend = el('ul', { className: 'chart-legend' }, publicState.players.map((p) => el('li', {},
    el('span', { className: 'swatch', style: { '--swatch': p.color } }), p.name)));
  return el('section', { className: 'game-stats', attrs: { 'aria-label': 'Game statistics' } },
    el('h3', { className: 'stats-title', text: 'Net worth over the game' }),
    worthChart(stats, publicState.players),
    legend,
    el('dl', { className: 'facts stats-facts' },
      el('div', {}, el('dt', { text: 'Most-landed tile' }), el('dd', { text: `${board.BOARD[top].name} (${landings[top]}×)` })),
      el('div', {}, el('dt', { text: 'Biggest rent paid' }), el('dd', {
        text: rent ? `${money(rent.amount)}: ${name(rent.from)} → ${name(rent.to)} on ${tileName(rent.tileId)}` : 'None',
      }))));
}

