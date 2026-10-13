// Trades: the Trades tab (incoming, outgoing, others'), the two-column trade
// builder, and notifications. The server re-checks everything; the builder
// just keeps obviously invalid choices out of reach and explains why.
import { board, rules } from '../shared.js';
import { el, render, $ } from '../dom.js';
import { money, groupName, tileName, describeSide, offerValue, nameLookup, tokenStyle } from '../format.js';
import { selectLegal, selectMe } from '../store.js';
import { openDialog } from './modal.js';
import { toast } from './toast.js';

const { BOARD, COLOR_GROUPS, GROUP_MEMBERS, getTileById, groupMembers } = board;
const { TRADE, MORTGAGE } = rules;

const emptySide = () => ({ tileIds: [], cash: 0, jailCards: [] });
const setHasBuildings = (props, group) => groupMembers(group).some((i) => props[BOARD[i].id].buildings > 0);
const feeFor = (tileId) => Math.round(getTileById(tileId).mortgageValue * MORTGAGE.transferFeeRatio);

export function createTrades({ store, act, sound, onOpenTab }) {
  const panel = $('#panel-trades');
  const badge = $('#trade-badge');

  // ===========================================================================
  // Panel
  // ===========================================================================

  function tradeCard(t, d, role) {
    const name = nameLookup(d.state);
    const ps = d.state.publicState;
    const legal = selectLegal(d).filter((a) => a.tradeId === t.id);
    // From my point of view: what I'd receive and what I'd hand over.
    const [mineGet, mineGive] = role === 'incoming' ? [t.give, t.get] : [t.get, t.give];
    const header = role === 'incoming' ? `From ${name(t.fromId)}` : role === 'outgoing' ? `To ${name(t.toId)}` : `${name(t.fromId)} → ${name(t.toId)}`;
    const lines = role === 'other'
      ? [el('p', { className: 'trade-line', text: `${describeSide(t.give)} for ${describeSide(t.get)}` })]
      : [
        el('p', { className: 'trade-line' }, el('span', { className: 'trade-label', text: 'You get' }), el('span', { text: describeSide(mineGet) })),
        el('p', { className: 'trade-line' }, el('span', { className: 'trade-label', text: 'You give' }), el('span', { text: describeSide(mineGive) })),
        el('p', { className: 'trade-value muted', text: `Value: you get ${money(offerValue(mineGet, ps.properties))}, you give ${money(offerValue(mineGive, ps.properties))}` }),
      ];
    const buttons = legal.map((a) => {
      if (a.type === 'counterTrade') {
        return el('button', {
          className: 'btn btn-secondary btn-sm', type: 'button', text: 'Counter', disabled: d.ui.busy, dataset: { action: a.type },
          on: { click: () => openBuilder({ partnerId: t.fromId, give: t.get, get: t.give, counterOf: t.id }) },
        });
      }
      const labels = { acceptTrade: 'Accept', declineTrade: 'Decline', cancelTrade: 'Cancel offer' };
      return el('button', {
        className: `btn ${a.type === 'acceptTrade' ? 'btn-primary' : 'btn-ghost'} btn-sm`, type: 'button',
        text: labels[a.type], disabled: d.ui.busy, dataset: { action: a.type },
        on: { click: () => act(a) },
      });
    });
    return el('li', { className: `trade-card trade-${role}`, dataset: { tradeId: t.id } },
      el('p', { className: 'trade-head', text: header }),
      lines,
      buttons.length ? el('div', { className: 'trade-actions' }, buttons) : null);
  }

  store.subscribe(
    (d) => d.state && d.state.publicState && d.you && {
      trades: d.state.publicState.trades,
      me: d.you.playerId,
      legal: selectLegal(d).filter((a) => a.tradeId),
      busy: d.ui.busy,
      phase: d.state.publicState.phase,
      players: d.state.publicState.players.map((p) => [p.id, p.bankrupt, p.cash < 0]),
    },
    (v, d) => {
      if (!v) return render(panel);
      const me = selectMe(d);
      const incoming = v.trades.filter((t) => t.toId === v.me);
      const outgoing = v.trades.filter((t) => t.fromId === v.me);
      const others = v.trades.filter((t) => t.toId !== v.me && t.fromId !== v.me);
      badge.hidden = !incoming.length;
      badge.textContent = incoming.length ? String(incoming.length) : '';

      const blocked = !me || me.bankrupt ? "You're out of the game."
        : me.cash < 0 ? 'Clear your debt before proposing a trade.'
          : v.phase === 'auction' ? 'Trading pauses during an auction.'
            : v.phase === 'gameOver' ? 'The game is over.'
              : outgoing.length >= TRADE.maxOpenPerPlayer ? `You have ${TRADE.maxOpenPerPlayer} open offers already.` : '';
      const section = (title, list, role) => (list.length
        ? [el('h3', { className: 'panel-title', text: title }), el('ul', { className: 'trade-list' }, list.map((t) => tradeCard(t, d, role)))]
        : []);
      render(panel,
        el('div', { className: 'trade-new' },
          el('button', { className: 'btn btn-primary', type: 'button', text: 'New trade', disabled: Boolean(blocked), dataset: { action: 'newTrade' }, on: { click: () => openBuilder({}) } }),
          blocked ? el('p', { className: 'muted', text: blocked }) : el('p', { className: 'muted', text: 'Swap cities, cash and jail-free cards. Trades are visible to everyone.' })),
        section('Offers to you', incoming, 'incoming'),
        section('Your offers', outgoing, 'outgoing'),
        section('Between other players', others, 'other'),
        v.trades.length ? null : el('p', { className: 'empty-row muted', text: 'No open trades.' }));
      return undefined;
    },
  );

  // Notifications
  store.onEvents((events) => {
    const me = store.you && store.you.playerId;
    const name = nameLookup(store.state);
    for (const e of events) {
      if (e.type === 'tradeProposed' && e.toId === me) {
        toast(`${name(e.fromId)} sent you a trade offer.`, { kind: 'good', important: true });
        sound.play('trade');
      }
      if (e.type === 'tradeAccepted' && e.fromId === me) {
        toast(`${name(e.toId)} accepted your trade!`, { kind: 'good', important: true });
        sound.play('trade');
      }
      if (e.type === 'tradeDeclined' && e.fromId === me) toast(`${name(e.toId)} ${e.countered ? 'countered' : 'declined'} your trade.`, { important: true });
      if (e.type === 'tradeCancelled' && e.reason !== 'withdrawn' && (e.fromId === me || e.toId === me)) toast(`Trade cancelled: ${e.reason}.`, { kind: 'bad', important: true });
    }
  });

  // ===========================================================================
  // Builder
  // ===========================================================================

  /**
   * Open the trade builder. partnerId: who to trade with (asks if omitted).
   * give / get prefill the sides; counterOf turns it into a counter-offer.
   */
  function openBuilder({ partnerId = null, give = emptySide(), get = emptySide(), counterOf = null }) {
    const draft = {
      partnerId,
      give: { tileIds: [...give.tileIds], cash: give.cash, jailCards: [...give.jailCards] },
      get: { tileIds: [...get.tileIds], cash: get.cash, jailCards: [...get.jailCards] },
    };
    const body = el('div', { className: 'builder' });
    const handle = openDialog({ className: 'dialog-trade', label: counterOf ? 'Counter-offer' : 'New trade', content: [body] });

    const paint = () => render(body, draft.partnerId ? builderView() : partnerPicker());

    function partnerPicker() {
      const ps = store.state.publicState;
      const others = ps.players.filter((p) => p.id !== store.you.playerId && !p.bankrupt);
      return [
        el('h2', { className: 'dialog-title', text: 'Trade with…' }),
        el('div', { className: 'partner-list' }, others.map((p) => el('button', {
          className: 'btn btn-secondary partner-btn', type: 'button', dataset: { partner: p.id },
          on: { click: () => { draft.partnerId = p.id; paint(); } },
        }, el('span', { className: 'token-disc token-disc-sm', style: tokenStyle(p.color), attrs: { 'aria-hidden': 'true' } }), el('span', { text: p.name }), el('span', { className: 'muted', text: money(p.cash) })))),
        el('div', { className: 'dialog-actions' }, el('button', { className: 'btn btn-ghost', type: 'button', text: 'Cancel', on: { click: () => handle.close() } })),
      ];
    }

    function sideColumn(title, owner, side, isMine) {
      const props = store.state.publicState.properties;
      const groups = Object.keys(GROUP_MEMBERS).map((group) => ({
        group,
        tiles: GROUP_MEMBERS[group].map((i) => BOARD[i]).filter((t) => props[t.id] && props[t.id].ownerId === owner.id),
      })).filter((g) => g.tiles.length);
      const cash = el('input', { type: 'range', className: 'cash-range', min: 0, max: Math.max(0, owner.cash), step: 10, value: String(side.cash), attrs: { 'aria-label': `${title}: cash` } });
      const cashNum = el('input', { type: 'number', className: 'input input-num', min: 0, max: Math.max(0, owner.cash), step: 1, value: String(side.cash), attrs: { 'aria-label': `${title}: cash amount` } });
      const setCash = (value) => {
        side.cash = Math.max(0, Math.min(Math.max(0, owner.cash), Math.floor(Number(value) || 0)));
        cash.value = String(side.cash);
        cashNum.value = String(side.cash);
        refreshSummary();
      };
      cash.addEventListener('input', () => setCash(cash.value));
      cashNum.addEventListener('change', () => setCash(cashNum.value));

      return el('section', { className: 'builder-col' },
        el('h3', { className: 'builder-col-title' }, title, el('span', { className: 'muted', text: ` · ${owner.name} has ${money(owner.cash)}` })),
        groups.length ? groups.map(({ group, tiles }) => {
          const built = setHasBuildings(props, group);
          return el('fieldset', { className: 'builder-group', style: { '--band': COLOR_GROUPS[group] ? COLOR_GROUPS[group].color : 'var(--ink-faint)' } },
            el('legend', { text: groupName(group) }),
            tiles.map((tile) => {
              const reason = built ? 'Sell the buildings in this set first' : '';
              const box = el('input', {
                type: 'checkbox', checked: side.tileIds.includes(tile.id), disabled: built,
                dataset: { tileId: tile.id },
                on: { change: (e) => { side.tileIds = e.target.checked ? [...side.tileIds, tile.id] : side.tileIds.filter((x) => x !== tile.id); refreshSummary(); } },
              });
              return el('label', { className: `builder-tile${built ? ' is-disabled' : ''}`, title: reason || tile.name },
                box, el('span', { text: tile.name }),
                props[tile.id].mortgaged ? el('span', { className: 'badge badge-bad', text: 'Mortgaged' }) : null,
                el('span', { className: 'muted', text: money(tile.price) }),
                reason ? el('span', { className: 'visually-hidden', text: `(${reason})` }) : null);
            }));
        }) : el('p', { className: 'muted', text: isMine ? "You don't own any cities." : `${owner.name} doesn't own any cities.` }),
        el('div', { className: 'builder-cash' }, el('span', { text: 'Cash' }), cash, el('span', { className: 'rupee-prefix', text: '₹', attrs: { 'aria-hidden': 'true' } }), cashNum),
        owner.jailFreeCards.length ? el('div', { className: 'builder-cards' }, owner.jailFreeCards.map((card) => el('label', { className: 'builder-tile' },
          el('input', {
            type: 'checkbox', checked: side.jailCards.includes(card.cardId),
            on: { change: (e) => { side.jailCards = e.target.checked ? [...side.jailCards, card.cardId] : side.jailCards.filter((x) => x !== card.cardId); refreshSummary(); } },
          }),
          el('span', { text: `Jail-free card (${card.deck === 'surprise' ? 'Surprise' : 'Treasure'})` })))) : null);
    }

    let summary = null;
    let submit = null;
    function refreshSummary() {
      if (!summary) return;
      const props = store.state.publicState.properties;
      const giveValue = offerValue(draft.give, props);
      const getValue = offerValue(draft.get, props);
      const fee = draft.get.tileIds.filter((id) => props[id].mortgaged).reduce((t, id) => t + feeFor(id), 0);
      const empty = !draft.give.tileIds.length && !draft.give.cash && !draft.give.jailCards.length
        && !draft.get.tileIds.length && !draft.get.cash && !draft.get.jailCards.length;
      render(summary,
        el('span', {}, 'You give ', el('strong', { text: money(giveValue) }), ' · you get ', el('strong', { text: money(getValue) })),
        el('span', { className: `builder-net ${getValue >= giveValue ? 'good' : 'bad'}`, text: `${getValue >= giveValue ? '+' : '−'}${money(Math.abs(getValue - giveValue))} for you` }),
        fee ? el('span', { className: 'muted', text: `You'll pay a ${money(fee)} fee on mortgaged cities you receive.` }) : null);
      submit.disabled = empty;
    }

    function builderView() {
      const ps = store.state.publicState;
      const me = ps.players.find((p) => p.id === store.you.playerId);
      const partner = ps.players.find((p) => p.id === draft.partnerId);
      summary = el('p', { className: 'builder-summary', attrs: { 'aria-live': 'polite' } });
      submit = el('button', { className: 'btn btn-primary', type: 'button', text: counterOf ? 'Send counter-offer' : 'Propose trade', dataset: { action: 'proposeTrade' } });
      submit.addEventListener('click', async () => {
        const action = counterOf
          ? { type: 'counterTrade', tradeId: counterOf, give: draft.give, get: draft.get }
          : { type: 'proposeTrade', toId: partner.id, give: draft.give, get: draft.get };
        const result = await act(action);
        if (result && result.ok) {
          handle.close();
          toast(`Offer sent to ${partner.name}.`, { kind: 'good' });
        }
      });
      const view = [
        el('header', { className: 'builder-head' },
          el('h2', { className: 'dialog-title', text: `${counterOf ? 'Counter-offer to' : 'Trade with'} ${partner.name}` }),
          counterOf ? null : el('button', { className: 'link-btn', type: 'button', text: 'Change player', on: { click: () => { draft.partnerId = null; draft.get = emptySide(); paint(); } } })),
        el('div', { className: 'builder-cols' },
          sideColumn('You give', me, draft.give, true),
          sideColumn(`${partner.name} gives`, partner, draft.get, false)),
        summary,
        el('div', { className: 'dialog-actions' }, el('button', { className: 'btn btn-ghost', type: 'button', text: 'Cancel', on: { click: () => handle.close() } }), submit),
      ];
      queueMicrotask(refreshSummary);
      return view;
    }

    paint();
    return handle;
  }

  return {
    openBuilder,
    /** From the tile popup: ask the owner of `tileId` for it. */
    proposeFor(tileId) {
      const owner = store.state.publicState.properties[tileId].ownerId;
      onOpenTab('trades');
      openBuilder({ partnerId: owner, get: { tileIds: [tileId], cash: 0, jailCards: [] } });
    },
    tileName,
  };
}
