// Event log, newest first. One entry list, mounted wherever it's needed.
import { el, clear } from '../dom.js';
import { describeEvent, nameLookup } from '../format.js';

const MAX_ENTRIES = 120;

export function createLog({ store }) {
  let entries = []; // newest first: { id, text, kind }
  let seq = 0;
  const views = new Set();
  let latestListener = () => {};

  const entryNode = (entry) => el('li', { className: `log-entry log-${entry.kind}`, text: entry.text });

  function mount(host) {
    const list = el('ol', { className: 'log-list', reversed: true, attrs: { 'aria-live': 'polite', 'aria-label': 'Game log' } });
    clear(host);
    host.append(list);
    views.add(list);
    for (const entry of entries) list.append(entryNode(entry));
  }

  /** Add the events of one state broadcast. */
  function addEvents(events) {
    const name = nameLookup(store.state);
    const fresh = [];
    for (const e of events) {
      const text = describeEvent(e, name);
      if (!text) continue;
      const kind = e.type === 'turnStarted' ? 'turn' : ['bankrupt', 'gameOver', 'sentToJail'].includes(e.type) ? 'big' : 'normal';
      fresh.push({ id: ++seq, text, kind });
    }
    if (!fresh.length) return;
    latestListener(fresh[fresh.length - 1].text);
    fresh.reverse();
    entries = [...fresh, ...entries].slice(0, MAX_ENTRIES);
    for (const list of views) {
      for (const entry of [...fresh].reverse()) list.prepend(entryNode(entry));
      while (list.children.length > MAX_ENTRIES) list.lastElementChild.remove();
    }
  }

  return {
    mount,
    addEvents,
    clear() {
      entries = [];
      for (const list of views) clear(list);
      latestListener('');
    },
    /** fn(text) with the newest entry, for the collapsed log strip's one-line preview. */
    onLatest(fn) { latestListener = fn; },
  };
}
