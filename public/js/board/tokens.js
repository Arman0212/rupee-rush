// Player tokens: coloured discs with the player's initial, offset when they
// share a tile, walking one tile at a time (positions come from the board
// layout, so they follow whatever direction play runs). Jailed tokens sit in
// the cell part of the jail corner; visitors stand along its outer edges.
import { board } from '../shared.js';
import { el, sleep, prefersReducedMotion } from '../dom.js';
import { initial, tokenStyle } from '../format.js';
import { cellRect, UNIT_PERCENT as U } from './grid.js';

const { BOARD_SIZE, JAIL_INDEX, boardSide } = board;

/** Offsets (in units of a side tile) for up to 8 tokens sharing a tile. */
function clusterOffsets(n, side) {
  const cols = n === 1 ? 1 : 2; // across the edge
  const rows = Math.ceil(n / cols); // along the depth of the tile
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const across = cols === 1 ? 0 : (c - 0.5) * 0.44;
    const depth = (r - (rows - 1) / 2) * 0.34;
    out.push(side === 'left' || side === 'right' ? [depth, across] : [across, depth]);
  }
  return out;
}

/** Where token `slot` of `count` stands, in % of the board. */
function spot(position, inJail, slot, count) {
  const rect = cellRect(position);
  if (position === JAIL_INDEX) {
    const c = rect.w;
    if (inJail) {
      // Jail is the top-right corner; its barred cell is the bottom-left part, facing the centre.
      const [dx, dy] = clusterOffsets(count, 'top')[slot];
      return { x: rect.x + c * 0.32 + dx * U * 0.8, y: rect.y + c * 0.68 + dy * U * 0.8 };
    }
    // "Just visiting" runs along the outer edges: the top (under its label) and the right.
    const path = [[0.15, 0.27], [0.4, 0.27], [0.62, 0.27], [0.84, 0.27], [0.84, 0.5], [0.84, 0.72], [0.84, 0.92], [0.62, 0.07]];
    const [fx, fy] = path[slot % path.length];
    return { x: rect.x + c * fx, y: rect.y + c * fy };
  }
  const [dx, dy] = clusterOffsets(count, boardSide(position))[slot];
  return { x: rect.x + rect.w / 2 + dx * U, y: rect.y + rect.h / 2 + dy * U };
}

export function createTokens(layer) {
  const tokens = new Map(); // playerId -> { node, position, inJail }

  function ensure(player) {
    let token = tokens.get(player.id);
    if (!token) {
      const node = el('div', { className: 'token', dataset: { player: player.id } });
      layer.append(node);
      token = { node, position: player.position, inJail: player.inJail };
      tokens.set(player.id, token);
    }
    token.node.textContent = initial(player.name);
    for (const [prop, value] of Object.entries(tokenStyle(player.color))) token.node.style.setProperty(prop, value);
    token.node.title = player.name;
    return token;
  }

  /** Lay out every token, grouping those on the same spot. */
  function place() {
    const groups = new Map();
    for (const [id, t] of tokens) {
      const key = `${t.position}:${t.position === JAIL_INDEX && t.inJail}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(id);
    }
    for (const ids of groups.values()) {
      ids.forEach((id, slot) => {
        const t = tokens.get(id);
        const { x, y } = spot(t.position, t.inJail, slot, ids.length);
        t.node.style.left = `${x}%`;
        t.node.style.top = `${y}%`;
        t.node.dataset.position = String(t.position);
        t.node.dataset.jail = String(t.position === JAIL_INDEX && t.inJail);
      });
    }
  }

  return {
    /** Snap every token to the game state (no animation). */
    sync(players, currentId) {
      const live = new Set();
      for (const p of players) {
        if (p.bankrupt) continue;
        live.add(p.id);
        const t = ensure(p);
        t.position = p.position;
        t.inJail = p.inJail;
        t.node.classList.toggle('current', p.id === currentId);
      }
      for (const [id, t] of tokens) {
        if (!live.has(id)) {
          t.node.remove();
          tokens.delete(id);
        }
      }
      place();
    },

    /** Walk a token tile by tile. Backwards for "go back" cards and trips to jail. */
    async walk(playerId, to, { backward = false, stepMs = 140 } = {}) {
      const t = tokens.get(playerId);
      if (!t) return;
      if (prefersReducedMotion() || document.hidden) {
        t.position = to;
        place();
        return;
      }
      const dir = backward ? -1 : 1;
      while (t.position !== to) {
        t.position = (t.position + dir + BOARD_SIZE) % BOARD_SIZE;
        place();
        await sleep(stepMs);
      }
    },

    /** Move a token without walking. */
    jump(playerId, position, { inJail } = {}) {
      const t = tokens.get(playerId);
      if (!t) return;
      t.position = position;
      if (inJail !== undefined) t.inJail = inJail;
      place();
    },

    setJail(playerId, inJail) {
      const t = tokens.get(playerId);
      if (!t) return;
      t.inJail = inJail;
      place();
    },

    position(playerId) {
      const t = tokens.get(playerId);
      return t ? t.position : null;
    },

    clear() {
      for (const t of tokens.values()) t.node.remove();
      tokens.clear();
    },
  };
}
