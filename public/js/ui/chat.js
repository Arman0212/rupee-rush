// Chat: one message list, any number of mounted views (lobby and game).
// Names and text go in through textContent only.
import { el, clear } from '../dom.js';
import { toast } from './toast.js';
import { icon } from './icons.js';

export function createChat({ net, store }) {
  let messages = [];
  const views = new Set();
  let unseen = 0;
  let onUnseen = () => {};

  const colourOf = (playerId) => {
    const seat = store.state && store.state.room.players.find((p) => p.id === playerId);
    return seat ? seat.color : 'var(--ink-faint)';
  };

  // Show the "Team only" toggle whenever team mode is on.
  store.subscribe(
    (d) => Boolean(d.state && d.state.room.settings.teams),
    (teams) => { for (const view of views) view.teamToggle.hidden = !teams; },
  );

  function messageNode(m) {
    const time = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return el('li', { className: `chat-msg${m.team ? ' chat-msg-team' : ''}` },
      el('span', { className: 'chat-name', text: m.name, style: { '--who': colourOf(m.playerId) } },
        m.bot ? icon('robot', { size: 12, label: 'bot' }) : null,
        m.team ? el('span', { className: 'chaos-badge', text: `Team ${m.team}` }) : null),
      el('span', { className: 'chat-text', text: m.text }),
      el('time', { className: 'chat-time', text: time, attrs: { datetime: new Date(m.ts).toISOString() } }));
  }

  function paint(view) {
    clear(view.list);
    for (const m of messages) view.list.append(messageNode(m));
    view.list.scrollTop = view.list.scrollHeight;
  }

  /** Mount a chat view into `host`. */
  function mount(host, { label = 'Chat message' } = {}) {
    const list = el('ul', { className: 'chat-list', attrs: { 'aria-live': 'polite', 'aria-label': 'Chat messages' } });
    const input = el('input', { className: 'input', maxLength: 200, placeholder: 'Say something…', attrs: { 'aria-label': label, autocomplete: 'off' } });
    const send = el('button', { className: 'btn btn-secondary', type: 'submit', text: 'Send' });
    const teamBox = el('input', { type: 'checkbox', attrs: { 'aria-label': 'Send to teammates only' } });
    const teamToggle = el('label', { className: 'chat-team-toggle', hidden: true }, teamBox, 'Team only');
    const form = el('form', { className: 'chat-form' }, input, send, teamToggle);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      send.disabled = true;
      const result = await net.emit('chat', { text, team: teamBox.checked });
      send.disabled = false;
      if (result.ok) input.value = '';
      else toast(result.error, { kind: 'bad' });
      input.focus();
    });
    clear(host);
    host.append(list, form);
    const view = { list, host, teamToggle };
    views.add(view);
    paint(view);
    return view;
  }

  return {
    mount,
    setHistory(list) {
      messages = list.slice();
      views.forEach(paint);
    },
    add(message) {
      messages.push(message);
      if (messages.length > 100) messages.shift();
      for (const view of views) {
        view.list.append(messageNode(message));
        while (view.list.children.length > 100) view.list.firstElementChild.remove();
        view.list.scrollTop = view.list.scrollHeight;
      }
      const mine = store.you && message.playerId === store.you.playerId;
      if (!mine) onUnseen(++unseen);
    },
    clear() {
      messages = [];
      views.forEach(paint);
    },
    /** For the "unread" badge on the chat tab. */
    onUnseen(fn) { onUnseen = fn; },
    markSeen() { unseen = 0; onUnseen(0); },
  };
}
