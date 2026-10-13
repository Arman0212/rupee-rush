// Short-lived notifications in a polite live region.
import { el } from '../dom.js';

const smallScreen = window.matchMedia('(max-width: 899px)');
const maxVisible = () => (smallScreen.matches ? 2 : 3);
let host = null;

export function initToasts(node) {
  host = node;
}

/** kind: 'info' | 'good' | 'bad' */
export function toast(text, { kind = 'info', timeout = 3500 } = {}) {
  if (!host || !text) return;
  const node = el('div', { className: `toast toast-${kind}`, text });
  host.append(node);
  while (host.children.length > maxVisible()) host.firstElementChild.remove();
  setTimeout(() => {
    node.classList.add('toast-out');
    setTimeout(() => node.remove(), 250);
  }, timeout);
}
