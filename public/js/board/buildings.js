// Houses as small dots, a hotel as one bar.
import { el, clear } from '../dom.js';
import { board } from '../shared.js';

export function renderBuildings(container, count) {
  clear(container);
  if (!count) return;
  if (count >= board.MAX_BUILDINGS) {
    container.append(el('span', { className: 'hotel' }));
    return;
  }
  for (let i = 0; i < count; i++) container.append(el('span', { className: 'house' }));
}
