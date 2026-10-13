// Modals on top of the native <dialog> element, which handles focus and Escape.
import { el } from '../dom.js';

/**
 * Open a dialog with the given content. Returns { dialog, close }.
 * modal: false shows it without a backdrop and without blocking the page.
 */
export function openDialog({ className = '', label, content, onClose, modal = true }) {
  const dialog = el('dialog', { className: `dialog ${className}`, attrs: { 'aria-label': label } });
  dialog.append(...[].concat(content).filter(Boolean));
  document.body.append(dialog);
  const close = () => { if (dialog.open) dialog.close(); };
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (onClose) onClose();
  });
  // Click on the backdrop closes it.
  dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });
  if (modal) dialog.showModal();
  else dialog.show();
  return { dialog, close };
}

/** Ask a yes/no question. Resolves true only if the confirm button was pressed. */
export function confirmDialog({ title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    let answer = false;
    const confirmBtn = el('button', {
      className: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, type: 'button', text: confirmLabel,
      dataset: { confirm: '' },
      on: { click: () => { answer = true; handle.close(); } },
    });
    const cancelBtn = el('button', { className: 'btn btn-ghost', type: 'button', text: cancelLabel, on: { click: () => handle.close() } });
    const handle = openDialog({
      className: 'dialog-confirm',
      label: title,
      content: [
        el('h2', { className: 'dialog-title', text: title }),
        el('p', { className: 'dialog-body', text: body }),
        el('div', { className: 'dialog-actions' }, cancelBtn, confirmBtn),
      ],
      onClose: () => resolve(answer),
    });
    cancelBtn.focus();
  });
}

let cardHandle = null;
let cardTimer = null;

/**
 * Show a drawn card; it closes itself after `ms` (or on OK / Escape).
 * Only your own cards are modal; other players' cards don't block the page.
 */
export function showCard({ deck, text, who, mine }, ms = 3000) {
  if (cardHandle) cardHandle.close();
  clearTimeout(cardTimer);
  const deckName = deck === 'surprise' ? 'Surprise' : 'Treasure';
  // 'close' fires asynchronously, so only clear state if this card is still the current one.
  const handle = openDialog({
    className: `dialog-card card-${deck}`,
    label: `${deckName} card`,
    content: [
      el('p', { className: 'card-deck', text: deckName }),
      el('p', { className: 'card-who', text: who }),
      el('p', { className: 'card-text', text }),
      el('button', { className: 'btn btn-ghost btn-sm', type: 'button', text: 'OK', on: { click: () => handle.close() } }),
    ],
    onClose: () => {
      if (cardHandle !== handle) return;
      cardHandle = null;
      clearTimeout(cardTimer);
    },
    modal: mine,
  });
  cardHandle = handle;
  cardTimer = setTimeout(() => handle.close(), ms);
}
