// Short-lived notifications and non-blocking card banners in a polite live region.
import { el, storage } from '../dom.js';

const NOTIF_KEY = 'rr:notifications';
const MAX_VISIBLE = 3;
let host = null;
let notifMode = storage.get(NOTIF_KEY) || 'all'; // 'all' | 'important' | 'off'

export function getNotificationMode() {
  return notifMode;
}

export function setNotificationMode(mode) {
  notifMode = mode;
  storage.set(NOTIF_KEY, mode);
}

export function initToasts(node) {
  host = node;
}

export function initNotifications(toggleBtn) {
  if (!toggleBtn) return;

  function paint() {
    const labels = {
      all: 'Notifications: All',
      important: 'Notifications: Important only',
      off: 'Notifications: Off',
    };
    const icons = {
      all: '🔔',
      important: '🛎️',
      off: '🔕',
    };
    toggleBtn.setAttribute('aria-label', labels[notifMode] || labels.all);
    toggleBtn.title = `${labels[notifMode] || labels.all} (click to change)`;
    toggleBtn.firstElementChild.textContent = icons[notifMode] || icons.all;
  }

  toggleBtn.addEventListener('click', () => {
    const cycle = { all: 'important', important: 'off', off: 'all' };
    setNotificationMode(cycle[notifMode] || 'all');
    paint();
  });

  paint();
}

function dismiss(node) {
  if (!node || !node.isConnected || node.dataset.dismissing) return;
  node.dataset.dismissing = 'true';
  node.classList.add('toast-out');
  setTimeout(() => node.remove(), 200);
}

function prune() {
  if (!host) return;
  while (host.children.length > MAX_VISIBLE) {
    host.firstElementChild.remove();
  }
}

/** kind: 'info' | 'good' | 'bad' */
export function toast(text, { kind = 'info', timeout = 3000, important = false } = {}) {
  if (!host || !text) return;
  if (notifMode === 'off') return;
  if (notifMode === 'important' && !important) return;

  const node = el('div', {
    className: `toast toast-${kind}`,
    text,
    attrs: { role: 'status', title: 'Click to dismiss' },
    on: { click: () => dismiss(node) },
  });

  host.append(node);
  prune();

  setTimeout(() => dismiss(node), timeout);
}

/**
 * Show a compact, non-blocking drawn-card banner in the notification area.
 * Auto-dismisses in ~4s, click to dismiss immediately.
 */
export function showCardBanner({ deck, text, who, mine }, ms = 4000) {
  if (!host || !text) return;
  if (notifMode === 'off') return;
  if (notifMode === 'important' && !mine) return;

  const deckName = deck === 'surprise' ? 'Surprise' : 'Treasure';
  const node = el('div', {
    className: `toast card-banner card-banner-${deck}`,
    attrs: { role: 'status', title: 'Click to dismiss' },
    on: { click: () => dismiss(node) },
  },
  el('div', { className: 'card-banner-header' },
    el('span', { className: 'card-banner-type', text: deckName }),
    who ? el('span', { className: 'card-banner-who', text: who }) : null
  ),
  el('p', { className: 'card-banner-body', text }));

  host.append(node);
  prune();

  setTimeout(() => dismiss(node), ms);
}
