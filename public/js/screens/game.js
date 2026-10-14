// Game mode of the room screen: board, centre (dice, actions, status), my
// properties and trades, banners and the game-over overlay.
//
// Static things (ownership, cash, buttons) repaint straight from the store.
// Things that happen (dice, token walks, cards, toasts) run through an effects
// queue, one event at a time, so a roll reads as: dice tumble → token walks →
// card / rent. Tokens snap back to the real state whenever the queue is idle.
import { board } from '../shared.js';
import { el, render, $, sleep } from '../dom.js';
import { money, tileName, actionLabel, nameLookup, tokenStyle } from '../format.js';
import { selectMe, selectLegal } from '../store.js';
import { buildGrid } from '../board/grid.js';
import { createTokens } from '../board/tokens.js';
import { createDice } from '../board/dice.js';
import { createTilePopup } from '../ui/popup.js';
import { createAuctionPanel } from '../ui/auction.js';
import { createTrades } from '../ui/trades.js';
import { statsBlock } from '../ui/stats.js';
import { createProperties } from '../ui/properties.js';
import { icon } from '../ui/icons.js';
import { confirmDialog, openDialog } from '../ui/modal.js';
import { toast, showCardBanner } from '../ui/toast.js';

const { JAIL_INDEX, BOARD_SIZE, netWorth } = board;

/** Turn actions shown as big buttons, in this order. Tile actions live in the popup and Cities tab. */
const MAIN_ACTIONS = ['buy', 'roll', 'payJailFine', 'useJailCard', 'decline', 'endTurn'];
const PRIMARY = new Set(['buy', 'roll', 'endTurn']);
const ACTION_ICONS = { roll: 'dice', buy: 'buy', decline: 'skip', endTurn: 'end', payJailFine: 'coin', useJailCard: 'key' };
/** Desktop keyboard shortcuts for the main turn actions. */
const SHORTCUTS = { r: 'roll', b: 'buy', e: 'endTurn' };
const KEY_FOR = Object.fromEntries(Object.entries(SHORTCUTS).map(([k, a]) => [a, k.toUpperCase()]));
const keyboardQuery = window.matchMedia('(hover: hover) and (pointer: fine) and (min-width: 900px)');

/**
 * Events from a state more than this many versions behind the latest are
 * applied without animation, so the board never lags the game by more than
 * one broadcast (fast players, auto-played turns, a tab coming back).
 */
const MAX_ANIMATION_LAG = 1;

export function createGameScreen({ store, net, act, sound, app, panes }) {
  const popup = createTilePopup({ store, act, onProposeTrade: (id) => trades.proposeFor(id) });
  const grid = buildGrid($('#board'), { onSelect: (id) => popup.show(id) });
  const tokens = createTokens($('#token-layer'));
  const dice = createDice($('#dice'));
  createProperties({ store, act, onSelectTile: (id) => popup.show(id) });
  const trades = createTrades({ store, act, sound, onOpenTab: (tab) => panes.select(tab) });
  createAuctionPanel({ store, act, hosts: [$('#center-auction')] });

  // Per-game memory, declared before any subscription can read it.
  const bankruptOrder = [];
  const effects = { queue: [], running: false, pendingBack: false };

  const meId = () => store.you && store.you.playerId;
  const names = () => nameLookup(store.state);

  // ===========================================================================
  // Board repaint
  // ===========================================================================

  store.subscribe(
    (d) => d.state && d.state.publicState && {
      props: d.state.publicState.properties,
      players: d.state.publicState.players.map((p) => ({ id: p.id, name: p.name, color: p.color })),
      settings: d.state.publicState.settings,
      jackpot: d.state.publicState.jackpot,
    },
    (v) => {
      if (!v) return;
      grid.update(store.state.publicState, new Map(v.players.map((p) => [p.id, p])), v.settings);
      const jackpot = $('#jackpot');
      jackpot.hidden = !v.settings.vacationJackpot;
      jackpot.textContent = `Vacation jackpot ${money(v.jackpot)}`;
    },
  );

  // Tokens follow the state whenever no animation is running.
  store.subscribe(
    (d) => d.state && d.state.publicState && {
      players: d.state.publicState.players.map((p) => ({ id: p.id, name: p.name, color: p.color, position: p.position, inJail: p.inJail, bankrupt: p.bankrupt })),
      current: d.state.publicState.currentPlayerId,
    },
    (v) => { if (v && !effects.running) tokens.sync(v.players, v.current); },
  );

  // Hooks for tests and styling.
  store.subscribe(
    (d) => d.state && d.state.publicState && { turn: d.state.publicState.turnNumber, phase: d.state.publicState.phase },
    (v) => {
      document.body.dataset.turn = v ? String(v.turn) : '';
      document.body.dataset.phase = v ? v.phase : '';
    },
  );

  // ===========================================================================
  // Turn info, timer
  // ===========================================================================

  // One-line status under the action buttons: whose turn it is and what's happening.
  store.subscribe(
    (d) => d.state && d.state.publicState && {
      current: d.state.publicState.currentPlayerId,
      phase: d.state.publicState.phase,
      pending: d.state.publicState.turn.pendingTileId,
      auctionTile: d.state.publicState.auction && d.state.publicState.auction.tileId,
      me: d.you && d.you.playerId,
      players: d.state.publicState.players.map((p) => ({ id: p.id, name: p.name, color: p.color, inJail: p.inJail, bankrupt: p.bankrupt, cash: p.cash })),
    },
    (v) => {
      const host = $('#turn-info');
      if (!v) return render(host);
      if (v.phase === 'gameOver') return render(host, el('span', { text: 'Game over' }));
      if (v.auctionTile) return render(host, el('span', { text: `Auction for ${tileName(v.auctionTile)}: bid or pass` }));
      const who = v.players.find((p) => p.id === v.current);
      const me = v.players.find((p) => p.id === v.me);
      if (!who) return render(host);
      const mine = who.id === v.me;
      const doing = mine
        ? { awaitingRoll: who.inJail ? 'roll for doubles, pay or use a card' : 'roll the dice', buyDecision: `buy ${tileName(v.pending)}?`, awaitingEnd: 'build, trade or end your turn' }[v.phase]
        : { awaitingRoll: who.inJail ? 'is in jail' : 'is rolling', buyDecision: `is deciding on ${tileName(v.pending)}`, awaitingEnd: 'is finishing their turn' }[v.phase];
      let text = mine ? `Your turn: ${doing || ''}` : `${who.name} ${doing || ''}`;
      if (me && me.bankrupt) text = `You're spectating · ${who.name}'s turn`;
      else if (me && me.cash < 0) text = 'Sell or mortgage to clear your debt';
      return render(host,
        el('span', { className: 'token-disc token-disc-sm', style: tokenStyle(who.color), attrs: { 'aria-hidden': 'true' } }),
        el('span', { className: 'status-text', text }));
    },
  );

  let timerFrame = null;
  store.subscribe(
    (d) => d.state && { deadline: d.state.deadline, seconds: d.state.room.settings.turnTimerSeconds },
    (v) => {
      cancelAnimationFrame(timerFrame);
      const box = $('#timer');
      if (!v || !v.deadline) {
        box.hidden = true;
        return;
      }
      box.hidden = false;
      const total = (v.seconds || 60) * 1000;
      const bar = box.querySelector('.timer-bar');
      const text = box.querySelector('.timer-text');
      const tick = () => {
        const left = Math.max(0, v.deadline - store.now());
        bar.style.width = `${Math.min(100, (left / total) * 100)}%`;
        const s = Math.ceil(left / 1000);
        text.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
        box.classList.toggle('urgent', left < 10_000);
        if (left > 0) timerFrame = requestAnimationFrame(tick);
      };
      tick();
    },
  );

  // ===========================================================================
  // Actions (only ever built from you.legalActions)
  // ===========================================================================

  function renderActions(host, v) {
    if (!v || v.auction) return render(host); // the auction panel takes over
    const publicState = store.state.publicState;
    const me = selectMe(store);
    const main = v.legal.filter((a) => MAIN_ACTIONS.includes(a.type)).sort((a, b) => MAIN_ACTIONS.indexOf(a.type) - MAIN_ACTIONS.indexOf(b.type));
    // The one-line status under the buttons says whose turn it is; no extra text here.
    const nodes = main.map((a) => el('button', {
      className: `btn ${PRIMARY.has(a.type) ? 'btn-primary' : 'btn-secondary'} btn-action`,
      type: 'button',
      disabled: v.busy,
      dataset: { action: a.type },
      attrs: { 'aria-busy': v.busy ? 'true' : null, 'aria-keyshortcuts': KEY_FOR[a.type] || null },
      on: { click: () => act(a) },
    }, ACTION_ICONS[a.type] ? icon(ACTION_ICONS[a.type], { size: 18 }) : null,
    el('span', { className: 'btn-label', text: actionLabel(a, { publicState, me }) }),
    KEY_FOR[a.type] ? el('kbd', { className: 'kbd-hint', text: KEY_FOR[a.type], attrs: { 'aria-hidden': 'true' } }) : null));
    return render(host, nodes);
  }

  store.subscribe(
    (d) => d.state && d.state.publicState && d.you && {
      legal: selectLegal(d),
      busy: d.ui.busy,
      status: d.state.room.status,
      me: d.you.playerId,
      turn: d.state.publicState.turn,
      current: d.state.publicState.currentPlayerId,
      auction: Boolean(d.state.publicState.auction),
    },
    (v) => renderActions($('#center-actions'), v),
  );

  // ===========================================================================
  // Banners: debt and spectating
  // ===========================================================================

  store.subscribe(
    (d) => {
      const me = selectMe(d);
      return me && { cash: me.cash, debt: me.debt.amount, creditor: me.debt.creditorId, bankrupt: me.bankrupt, status: d.state.room.status };
    },
    (v) => {
      const host = $('#game-banners');
      if (!v || v.status !== 'playing') return render(host);
      if (v.bankrupt) {
        return render(host, el('div', { className: 'banner banner-muted', attrs: { role: 'status' } },
          el('p', { text: "You're bankrupt and spectating. You can still chat." })));
      }
      if (v.cash < 0) {
        const to = names()(v.creditor);
        return render(host, el('div', { className: 'banner banner-danger', attrs: { role: 'alert' } },
          el('p', { className: 'banner-text', text: `You owe ${money(v.debt)} to ${to}. Sell or mortgage to continue.` }),
          el('div', { className: 'banner-actions' },
            el('button', { className: 'btn btn-secondary btn-sm', type: 'button', text: 'My properties', on: { click: () => panes.select('properties', { focus: true }) } }),
            el('button', {
              className: 'btn btn-danger btn-sm', type: 'button', text: 'Declare bankruptcy', dataset: { action: 'bankrupt' },
              on: {
                click: async () => {
                  const yes = await confirmDialog({
                    title: 'Declare bankruptcy?',
                    body: `You're out of the game. Your cash, cities and cards go to ${to}.`,
                    confirmLabel: 'Declare bankruptcy',
                    danger: true,
                  });
                  if (yes) act({ type: 'bankrupt' });
                },
              },
            }))));
      }
      return render(host);
    },
  );

  // ===========================================================================
  // Game over
  // ===========================================================================

  let shownGameOver = null;
  store.subscribe(
    (d) => d.state && d.state.room.status === 'finished' && d.state.publicState && {
      winner: d.state.publicState.winnerId,
      turn: d.state.publicState.turnNumber,
      isHost: d.you && d.you.isHost,
    },
    (v) => {
      if (!v) {
        // Back to the lobby (play again) or left the room: take the overlay down.
        if (shownGameOver) shownGameOver.handle.close();
        shownGameOver = null;
        return;
      }
      const key = `${v.winner}:${v.turn}`;
      if (shownGameOver && shownGameOver.key === key) {
        // Host may have changed while the overlay is open.
        shownGameOver.again.hidden = !v.isHost;
        return;
      }
      if (shownGameOver) shownGameOver.handle.close();
      shownGameOver = showGameOver(v, key);
    },
  );

  function showGameOver(v, key) {
    const ps = store.state.publicState;
    const winner = ps.players.find((p) => p.id === v.winner);
    const order = [...ps.players].sort((a, b) => {
      if (a.id === v.winner) return -1;
      if (b.id === v.winner) return 1;
      const ka = bankruptOrder.indexOf(a.id);
      const kb = bankruptOrder.indexOf(b.id);
      if (ka !== kb) return kb - ka; // went bankrupt later = placed higher
      return netWorth(b, ps.properties) - netWorth(a, ps.properties);
    });
    const again = el('button', {
      className: 'btn btn-primary btn-lg', type: 'button', text: 'Play again', hidden: !v.isHost,
      on: { click: async () => { const r = await net.emit('playAgain'); if (!r.ok) toast(r.error, { kind: 'bad' }); } },
    });
    const handle = openDialog({
      className: 'dialog-gameover',
      label: 'Game over',
      content: [
        el('p', { className: 'eyebrow', text: 'Game over' }),
        el('h2', { className: 'gameover-title', text: winner ? `${winner.name} wins!` : 'Game over' }),
        statsBlock(ps, store.state),
        el('ol', { className: 'standings' }, order.map((p, i) => el('li', { className: p.id === v.winner ? 'is-winner' : '' },
          el('span', { className: 'standing-rank', text: `${i + 1}` }),
          el('span', { className: 'token-disc token-disc-sm', style: tokenStyle(p.color), attrs: { 'aria-hidden': 'true' } }),
          el('span', { className: 'standing-name', text: p.name }),
          el('span', { className: 'standing-worth', text: p.bankrupt ? 'Bankrupt' : money(netWorth(p, ps.properties)) })))),
        el('div', { className: 'dialog-actions' },
          el('button', { className: 'btn btn-ghost', type: 'button', text: 'View board', on: { click: () => handle.close() } }),
          el('button', { className: 'btn btn-secondary', type: 'button', text: 'Leave room', on: { click: () => app.leave({ confirm: false }) } }),
          again),
        v.isHost ? null : el('p', { className: 'muted', text: 'The host can start another round with the same settings.' }),
      ],
    });
    return { key, handle, again };
  }

  // ===========================================================================
  // Effects queue
  // ===========================================================================

  store.onEvents((events, payload) => {
    if (!store.state || !store.state.publicState) return;
    for (const event of events) effects.queue.push({ event, version: payload.version });
    drain();
  });

  async function drain() {
    if (effects.running) return;
    effects.running = true;
    document.body.dataset.animating = 'true';
    try {
      while (effects.queue.length) {
        const { event, version } = effects.queue.shift();
        const fast = document.hidden || store.state.version - version > MAX_ANIMATION_LAG;
        await runEffect(event, fast);
      }
    } catch (err) {
      console.error(err);
    } finally {
      effects.running = false;
      delete document.body.dataset.animating;
      const ps = store.state && store.state.publicState;
      if (ps) tokens.sync(ps.players, ps.currentPlayerId);
    }
  }

  async function runEffect(e, fast) {
    const me = meId();
    const name = names();
    switch (e.type) {
      case 'diceRolled':
        sound.play('dice');
        if (fast) dice.show(e.dice);
        else await dice.roll(e.dice);
        break;
      case 'moved': {
        const forward = (e.to - e.from + BOARD_SIZE) % BOARD_SIZE;
        const backward = effects.pendingBack && forward > BOARD_SIZE / 2;
        effects.pendingBack = false;
        // Start from where the server says the move began (e.g. after leaving jail).
        if (tokens.position(e.playerId) !== e.from) tokens.jump(e.playerId, e.from, { inJail: false });
        if (fast) tokens.jump(e.playerId, e.to);
        else await tokens.walk(e.playerId, e.to, { backward });
        break;
      }
      case 'sentToJail': {
        sound.play('jail');
        if (!fast && tokens.position(e.playerId) !== null && tokens.position(e.playerId) !== JAIL_INDEX) {
          await tokens.walk(e.playerId, JAIL_INDEX, { backward: true, stepMs: 45 });
        }
        tokens.jump(e.playerId, JAIL_INDEX, { inJail: true });
        if (e.playerId === me) toast('You were sent to jail!', { kind: 'bad', important: true });
        break;
      }
      case 'leftJail':
        tokens.setJail(e.playerId, false);
        break;
      case 'cardDrawn':
        effects.pendingBack = e.kind === 'moveBy';
        showCardBanner({ deck: e.deck, text: e.text, who: e.playerId === me ? 'You drew' : `${name(e.playerId)} drew`, mine: e.playerId === me });
        if (!fast) await sleep(700);
        break;
      case 'rentPaid':
        if (e.from === me) { toast(`You paid ${name(e.to)} ${money(e.amount)} rent for ${tileName(e.tileId)}.`, { kind: 'bad', important: true }); sound.play('cash'); }
        if (e.to === me) { toast(`${name(e.from)} paid you ${money(e.amount)} rent for ${tileName(e.tileId)}.`, { kind: 'good', important: true }); sound.play('cash'); }
        break;
      case 'moneyCollected':
        if (e.to === me && e.reason === 'goSalary') { toast(`You collected ${money(e.amount)} salary.`, { kind: 'good', important: false }); sound.play('cash'); }
        break;
      case 'taxPaid':
        if (e.from === me) toast(`You paid ${money(e.amount)} ${tileName(e.tileId)}.`, { kind: 'bad', important: false });
        break;
      case 'jackpotCollected':
        toast(e.to === me ? `You won the ${money(e.amount)} jackpot!` : `${name(e.to)} won the ${money(e.amount)} jackpot!`, { kind: 'good', important: false });
        sound.play('cash');
        break;
      case 'turnStarted':
        if (e.playerId === me) toast('Your turn!', { kind: 'good', timeout: 2000, important: false });
        break;
      case 'bankrupt':
        bankruptOrder.push(e.playerId);
        break;
      case 'bidPlaced':
        sound.play('bid');
        break;
      case 'auctionClosed':
        if (e.winnerId === me) { toast(`You won ${tileName(e.tileId)} for ${money(e.amount)}!`, { kind: 'good', important: true }); sound.play('cash'); }
        break;
      default:
        break;
    }
  }

  // ===========================================================================
  // Keyboard shortcuts (desktop): R roll, B buy, E end turn
  // ===========================================================================

  document.addEventListener('keydown', (e) => {
    if (document.body.dataset.screen !== 'game' || !keyboardQuery.matches) return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (e.target.closest('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open]:modal')) return;
    const type = SHORTCUTS[e.key.toLowerCase()];
    const action = type && selectLegal(store).find((a) => a.type === type);
    if (!action) return;
    e.preventDefault();
    act(action);
  });

  return {
    show() {
      const ps = store.state && store.state.publicState;
      if (ps) {
        tokens.sync(ps.players, ps.currentPlayerId);
        if (ps.turn.dice) dice.show(ps.turn.dice);
      }
    },
    hide() {
      popup.close();
      effects.queue.length = 0;
    },
    /** A new game (or a different room): forget per-game memory. */
    reset() {
      tokens.clear();
      bankruptOrder.length = 0;
      effects.queue.length = 0;
      if (shownGameOver) shownGameOver.handle.close();
      shownGameOver = null;
    },
  };
}
