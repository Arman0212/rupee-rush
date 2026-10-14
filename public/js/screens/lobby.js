// Room shell parts that matter in the lobby (and some all game long): the
// "Share this game" card, the room code and Start button in the board centre,
// the player list and the settings cards.
import { rules } from '../shared.js';
import { $ } from '../dom.js';
import { toast } from '../ui/toast.js';
import { icon } from '../ui/icons.js';
import { createPlayerList } from '../ui/players.js';
import { createSettings } from '../ui/settings.js';

export function createLobbyScreen({ store, net }) {
  createPlayerList({ store, net });
  createSettings({ store, net });

  // --- Share this game ------------------------------------------------------------
  const shareUrl = $('#share-url');
  const copy = $('#share-copy');
  copy.prepend(icon('copy', { size: 16 }));
  const inviteLink = () => `${location.origin}/r/${store.state.room.code}`;
  shareUrl.addEventListener('focus', () => shareUrl.select());
  copy.addEventListener('click', async () => {
    const url = inviteLink();
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    if (navigator.share && coarse) {
      try {
        await navigator.share({ title: rules.GAME_NAME, text: `Join my ${rules.GAME_NAME} game!`, url });
        return;
      } catch { /* cancelled or unsupported: fall back to copying */ }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast('Invite link copied.', { kind: 'good', important: true });
    } catch {
      shareUrl.focus();
      toast('Press Ctrl+C (or ⌘C) to copy the selected link.', { timeout: 6000, important: true });
    }
  });

  // --- Board centre: room code, player count, Start -------------------------------------
  const start = $('#lobby-start');
  start.prepend(icon('play', { size: 18 }));
  store.subscribe(
    (d) => d.state && { code: d.state.room.code, status: d.state.room.status, players: d.state.room.players.length, max: d.state.room.settings.maxPlayers, host: (d.state.room.players.find((p) => p.isHost) || {}).name, isHost: Boolean(d.you && d.you.isHost) },
    (v) => {
      if (!v) return;
      shareUrl.value = inviteLink();
      $('#lobby-code').textContent = v.code;
      if (v.status !== 'lobby') return;
      $('#lobby-count').textContent = `${v.players} of ${v.max} seats taken`;
      const enough = v.players >= 2;
      start.hidden = !v.isHost;
      start.disabled = !enough;
      $('#lobby-start-hint').textContent = v.isHost
        ? (enough ? 'Everyone ready? Start whenever you like.' : 'Share the link: you need at least 2 players.')
        : `Waiting for ${v.host || 'the host'} to start…`;
    },
  );
  start.addEventListener('click', async () => {
    start.disabled = true;
    const r = await net.emit('startGame');
    if (!r.ok) {
      toast(r.error, { kind: 'bad', important: true });
      start.disabled = false;
    }
  });

  return {
    show() {},
    hide() {},
  };
}
