// Auction panel: the tile up for grabs, the high bid and who holds it, a
// countdown that visibly resets on every bid, quick bids, a custom amount and Pass.
import { board, rules } from '../shared.js';
import { el, render } from '../dom.js';
import { money, groupName, tokenStyle } from '../format.js';
import { selectLegal, selectMe } from '../store.js';

const { getTileById, COLOR_GROUPS } = board;
const { AUCTION } = rules;

export function createAuctionPanel({ store, act, hosts }) {
  let frame = null;

  function view(d) {
    const ps = d.state && d.state.publicState;
    const auction = ps && ps.auction;
    if (!auction) return null;
    const legal = selectLegal(d);
    const me = selectMe(d);
    return {
      auction,
      players: ps.players.map((p) => ({ id: p.id, name: p.name, color: p.color })),
      me: me && { id: me.id, cash: me.cash },
      minBid: (legal.find((a) => a.type === 'bid') || {}).amount ?? null,
      canPass: legal.some((a) => a.type === 'pass'),
      busy: d.ui.busy,
      seconds: d.state.room.settings.auctionSeconds,
    };
  }

  function panel(v) {
    const { auction } = v;
    const tile = getTileById(auction.tileId);
    const band = tile.group && COLOR_GROUPS[tile.group] ? COLOR_GROUPS[tile.group].color : 'var(--indigo)';
    const leader = v.players.find((p) => p.id === auction.highBidderId);
    const mine = v.me && auction.highBidderId === v.me.id;
    const stillIn = v.me && auction.bidders.includes(v.me.id);

    const controls = [];
    if (v.minBid !== null) {
      const quick = AUCTION.quickBids.map((step) => {
        const amount = Math.max(v.minBid, auction.highBid + step);
        return el('button', {
          className: 'btn btn-secondary btn-sm quick-bid', type: 'button',
          text: `+${money(step)}`,
          disabled: v.busy || amount > v.me.cash,
          title: amount > v.me.cash ? `You only have ${money(v.me.cash)}` : `Bid ${money(amount)}`,
          attrs: { 'aria-label': `Bid ${money(amount)}` },
          dataset: { action: 'bid', amount: String(amount) },
          on: { click: () => act({ type: 'bid', amount }) },
        });
      });
      const input = el('input', {
        className: 'input input-num bid-input', type: 'number', inputMode: 'numeric',
        min: v.minBid, max: v.me.cash, step: 1, value: String(Math.min(v.minBid, v.me.cash)),
        attrs: { 'aria-label': 'Your bid in rupees' },
      });
      const bidBtn = el('button', { className: 'btn btn-primary btn-sm', type: 'submit', text: 'Bid', disabled: v.busy || v.minBid > v.me.cash, dataset: { action: 'bid-custom' } });
      const form = el('form', { className: 'bid-form' }, el('span', { className: 'rupee-prefix', text: '₹', attrs: { 'aria-hidden': 'true' } }), input, bidBtn);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const amount = Math.floor(Number(input.value));
        if (Number.isFinite(amount)) act({ type: 'bid', amount });
      });
      controls.push(el('div', { className: 'quick-bids' }, quick), form);
    }
    if (v.canPass) {
      controls.push(el('button', { className: 'btn btn-ghost btn-sm pass-btn', type: 'button', text: 'Pass', disabled: v.busy, dataset: { action: 'pass' }, on: { click: () => act({ type: 'pass' }) } }));
    }
    let status = '';
    if (mine) status = "You're the high bidder.";
    else if (v.me && !stillIn) status = "You've passed on this one.";
    else if (v.minBid !== null && v.minBid > v.me.cash) status = `You need ${money(v.minBid)} to bid.`;

    return el('section', { className: 'auction', attrs: { 'aria-label': `Auction for ${tile.name}`, 'aria-live': 'polite' } },
      el('div', { className: 'auction-tile', style: { '--band': band } },
        el('span', { className: 'auction-eyebrow', text: 'Auction' }),
        el('span', { className: 'auction-name', text: tile.name }),
        el('span', { className: 'auction-sub', text: `${tile.group ? groupName(tile.group) : ''} · list price ${money(tile.price)}` })),
      el('div', { className: 'auction-high' },
        el('span', { className: 'auction-amount', text: auction.highBid ? money(auction.highBid) : 'No bids yet' }),
        leader ? el('span', { className: 'auction-leader' },
          el('span', { className: 'token-disc token-disc-sm', style: tokenStyle(leader.color), attrs: { 'aria-hidden': 'true' } }),
          el('span', { text: leader.name })) : null),
      el('div', { className: 'auction-timer' }, el('div', { className: 'auction-bar' }), el('span', { className: 'auction-secs' })),
      status ? el('p', { className: 'auction-status muted', text: status }) : null,
      controls.length ? el('div', { className: 'auction-controls' }, controls) : null);
  }

  /** Countdown against server time; the bar jumps back to full when a bid resets endsAt. */
  function tick(endsAt, seconds) {
    cancelAnimationFrame(frame);
    if (!endsAt) return;
    const total = seconds * 1000;
    const step = () => {
      const left = Math.max(0, endsAt - store.now());
      for (const host of hosts) {
        const bar = host.querySelector('.auction-bar');
        const secs = host.querySelector('.auction-secs');
        if (!bar) continue;
        bar.style.width = `${Math.min(100, (left / total) * 100)}%`;
        bar.classList.toggle('urgent', left < 3000);
        secs.textContent = `${Math.ceil(left / 1000)}s`;
      }
      if (left > 0) frame = requestAnimationFrame(step);
    };
    step();
  }

  let lastEndsAt = null;
  store.subscribe(view, (v) => {
    for (const host of hosts) {
      // Keep a half-typed custom bid when only the countdown moved.
      const typing = host.contains(document.activeElement) && document.activeElement.classList.contains('bid-input');
      if (typing && v) continue;
      render(host, v ? panel(v) : null);
    }
    if (!v) {
      cancelAnimationFrame(frame);
      lastEndsAt = null;
      return;
    }
    if (v.auction.endsAt !== lastEndsAt) {
      for (const host of hosts) {
        const timer = host.querySelector('.auction-timer');
        if (timer && lastEndsAt) {
          timer.classList.remove('reset');
          void timer.offsetWidth; // restart the flash animation
          timer.classList.add('reset');
        }
      }
      lastEndsAt = v.auction.endsAt;
    }
    tick(v.auction.endsAt, v.seconds);
  });
}
