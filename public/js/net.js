// Socket wrapper: promise-based emit with ack + timeout, back-off on rate limits,
// automatic rejoin with the stored token after a reconnect, and a status pill.
import { storage, sleep } from './dom.js';

const ACK_TIMEOUT_MS = 6000;
const MAX_RATE_RETRIES = 5;

export const tokens = {
  key: (code) => `rr:token:${code}`,
  get: (code) => storage.get(tokens.key(code)),
  set: (code, token) => storage.set(tokens.key(code), token),
  remove: (code) => storage.remove(tokens.key(code)),
};

/**
 * @param {object} opts
 * @param {(status: 'connecting'|'online'|'reconnecting'|'offline') => void} opts.onStatus
 * @param {(result) => void} opts.onRejoin called with the joinRoom result after an automatic rejoin
 */
export function createNet({ onStatus, onRejoin }) {
  // Same origin; websocket first, long-polling where a proxy or network blocks websockets.
  const socket = window.io({ reconnectionDelayMax: 5000, transports: ['websocket', 'polling'] });
  let session = null; // { code, token } of the room we hold a seat in
  let everConnected = false;

  socket.on('connect', async () => {
    onStatus('online');
    // After a drop the server sees a brand-new socket: reclaim the seat.
    if (everConnected && session) onRejoin(await emit('joinRoom', { code: session.code, token: session.token }));
    everConnected = true;
  });
  socket.on('disconnect', () => onStatus(navigator.onLine === false ? 'offline' : 'reconnecting'));
  socket.on('connect_error', () => onStatus(everConnected ? 'reconnecting' : 'connecting'));
  window.addEventListener('offline', () => onStatus('offline'));
  window.addEventListener('online', () => { if (!socket.connected) onStatus('reconnecting'); });

  /**
   * Emit and wait for the ack. Never rejects: failures come back as
   * { ok: false, error }. "rate limited" replies are retried with back-off.
   */
  async function emit(event, payload = {}, { timeoutMs = ACK_TIMEOUT_MS } = {}) {
    for (let attempt = 0; ; attempt++) {
      let result;
      try {
        result = await socket.timeout(timeoutMs).emitWithAck(event, payload);
      } catch {
        result = { ok: false, error: socket.connected ? 'The server did not answer in time.' : 'You are offline.' };
      }
      if (result && !result.ok && result.error === 'rate limited' && attempt < MAX_RATE_RETRIES) {
        await sleep(150 * 2 ** attempt + Math.random() * 100);
        continue;
      }
      return result || { ok: false, error: 'No reply from the server.' };
    }
  }

  return {
    socket,
    emit,
    on: (event, fn) => socket.on(event, fn),
    get session() { return session; },
    setSession(code, token) { session = { code, token }; },
    clearSession() { session = null; },
  };
}

const STATUS_TEXT = { connecting: 'Connecting…', online: 'Online', reconnecting: 'Reconnecting…', offline: 'Offline' };

/** Keep the connection pill in the top bar in step with the socket. */
export function statusPill(node) {
  return (status) => {
    node.textContent = STATUS_TEXT[status] || status;
    node.className = `pill pill-${status}`;
  };
}
