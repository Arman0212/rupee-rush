// Client state: the last 'state' and 'you' payloads plus a little UI state.
// Stale payloads (older version) are ignored. Subscribers pick a slice with a
// selector and only re-run when that slice actually changed.

export function createStore() {
  const data = { state: null, you: null, ui: { busy: false } };
  let clockOffset = 0; // server time minus local time, from 'state'.serverNow
  const subscribers = new Set();
  const eventListeners = new Set();

  function notify() {
    for (const sub of subscribers) {
      let key;
      let value;
      try {
        value = sub.select(data);
        key = JSON.stringify(value) ?? 'undefined';
      } catch (err) {
        console.error(err);
        continue;
      }
      if (key === sub.last) continue;
      sub.last = key;
      sub.fn(value, data);
    }
  }

  return {
    get state() { return data.state; },
    get you() { return data.you; },
    get ui() { return data.ui; },

    /** Server time now, for countdowns against server deadlines (turn timer, auctions). */
    now() { return Date.now() + clockOffset; },

    /** Apply a 'state' broadcast. Returns false if it was older than what we have. */
    applyState(payload) {
      const current = data.state ? data.state.version : 0;
      if (payload.version < current) return false;
      const isNew = payload.version > current;
      if (typeof payload.serverNow === 'number') clockOffset = payload.serverNow - Date.now();
      data.state = payload;
      if (isNew && payload.events.length) for (const fn of eventListeners) fn(payload.events, payload);
      notify();
      return true;
    },

    applyYou(payload) {
      if (data.you && payload.version < data.you.version) return;
      data.you = payload;
      notify();
    },

    setUi(partial) {
      data.ui = { ...data.ui, ...partial };
      notify();
    },

    /** Forget everything (left the room, kicked, room closed). */
    reset() {
      data.state = null;
      data.you = null;
      data.ui = { busy: false };
      notify();
    },

    /** fn(value, data) runs whenever select(data) changes (deep compare). Returns an unsubscribe function. */
    subscribe(select, fn) {
      const sub = { select, fn, last: undefined };
      subscribers.add(sub);
      const value = select(data);
      sub.last = JSON.stringify(value) ?? 'undefined';
      fn(value, data);
      return () => subscribers.delete(sub);
    },

    /** fn(events, payload) for each new state that carries events. */
    onEvents(fn) {
      eventListeners.add(fn);
      return () => eventListeners.delete(fn);
    },
  };
}

// Common selectors

/**
 * Legal actions, but only once 'you' has caught up with the latest 'state'
 * (each broadcast sends 'state' first, then 'you'). Until then: none, so a
 * button is never built from one state's actions and another state's data.
 */
export const selectLegal = (d) => {
  if (!d.you || !d.state || d.you.version < d.state.version) return [];
  return d.you.legalActions;
};

export const selectMe = (d) => {
  if (!d.you || !d.state || !d.state.publicState) return null;
  return d.state.publicState.players.find((p) => p.id === d.you.playerId) || null;
};
