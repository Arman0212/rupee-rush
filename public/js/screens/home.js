// Home: name, create, join by code, and the public room list (refreshed every 5s).
import { rules } from '../shared.js';
import { el, render, $, storage } from '../dom.js';

const REFRESH_MS = 5000;
const NAME_KEY = 'rr:name';

export function normalizeCode(raw) {
  const code = String(raw || '').trim().toUpperCase();
  const { codeLength, codeAlphabet } = rules.ROOM;
  return code.length === codeLength && [...code].every((c) => codeAlphabet.includes(c)) ? code : null;
}

export function createHomeScreen({ net, app }) {
  const nameInput = $('#home-name');
  const codeInput = $('#home-code');
  const createBtn = $('#home-create');
  const hint = $('#home-hint');
  const list = $('#home-rooms');
  let timer = null;

  nameInput.value = storage.get(NAME_KEY) || '';
  nameInput.addEventListener('input', () => storage.set(NAME_KEY, nameInput.value.trim()));
  codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.toUpperCase(); });

  /** A name is needed before creating or joining. */
  function requireName() {
    const name = nameInput.value.trim();
    if (name) return name;
    hint.textContent = 'Enter your name first.';
    nameInput.focus();
    return null;
  }

  async function busy(button, fn) {
    button.disabled = true;
    try { await fn(); } finally { button.disabled = false; }
  }

  createBtn.addEventListener('click', () => {
    const name = requireName();
    if (name) busy(createBtn, () => app.create(name));
  });

  $('#home-join').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = normalizeCode(codeInput.value);
    if (!code) {
      hint.textContent = `Room codes are ${rules.ROOM.codeLength} letters and numbers, like K7PQ2M.`;
      codeInput.focus();
      return;
    }
    const name = requireName();
    if (name) busy($('#home-join-btn'), () => app.join(code, name));
  });

  async function refresh() {
    const result = await net.emit('listRooms');
    if (!result.ok) return;
    if (!result.rooms.length) {
      render(list, el('li', { className: 'empty-row muted', text: 'No open rooms right now. Create one and invite your friends!' }));
      return;
    }
    render(list, result.rooms.map((room) => el('li', { className: 'room-row' },
      el('span', { className: 'room-row-main' },
        el('span', { className: 'room-row-host', text: `${room.hostName}'s room` }),
        room.mode === 'chaos' ? el('span', { className: 'chaos-badge', text: 'Chaos' }) : null,
        el('span', { className: 'muted', text: ` · ${room.players}/${room.maxPlayers} players` })),
      el('button', {
        className: 'btn btn-secondary btn-sm', type: 'button', text: 'Join',
        disabled: room.players >= room.maxPlayers,
        attrs: { 'aria-label': `Join ${room.hostName}'s room, ${room.code}` },
        on: { click: (e) => { const name = requireName(); if (name) busy(e.currentTarget, () => app.join(room.code, name)); } },
      }))));
  }

  return {
    /** Show home, optionally pre-filled to join a room from an invite link. */
    show({ code, message } = {}) {
      if (code) codeInput.value = code;
      hint.textContent = message || '';
      refresh();
      clearInterval(timer);
      timer = setInterval(refresh, REFRESH_MS);
      (code && !nameInput.value ? nameInput : (nameInput.value ? createBtn : nameInput)).focus({ preventScroll: true });
    },
    hide() {
      clearInterval(timer);
      timer = null;
    },
  };
}
