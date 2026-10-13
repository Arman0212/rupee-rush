'use strict';

/**
 * Tiny hand-written payload validators for socket events.
 *
 * A schema maps field names to checks. Each check is `(value) => error | null`.
 * validatePayload() rejects anything that isn't a plain object, reports the
 * first bad field, and returns a copy holding only the known fields, so stray
 * keys from a client never reach the room or the engine.
 */

const { ROOM } = require('../../shared/rules');

const isPlainObject = (x) => x !== null && typeof x === 'object' && Object.getPrototypeOf(x) === Object.prototype;

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const str = ({ min = 0, max }) => (v) => {
  if (typeof v !== 'string') return 'must be a string';
  if (v.length < min) return min === 1 ? 'must not be empty' : `must be at least ${min} characters`;
  if (v.length > max) return `must be at most ${max} characters`;
  return null;
};

const int = ({ min, max }) => (v) =>
  Number.isInteger(v) && v >= min && v <= max ? null : `must be a whole number from ${min} to ${max}`;

const bool = () => (v) => (typeof v === 'boolean' ? null : 'must be true or false');

/** A flat object of primitives, e.g. a partial settings object. */
const flatObject = ({ maxKeys }) => (v) => {
  if (!isPlainObject(v)) return 'must be an object';
  const entries = Object.entries(v);
  if (entries.length > maxKeys) return `must have at most ${maxKeys} keys`;
  const primitive = (x) => ['string', 'number', 'boolean'].includes(typeof x);
  return entries.every(([, x]) => primitive(x)) ? null : 'must only contain strings, numbers and booleans';
};

/** Marks a check as optional: undefined passes, anything else must satisfy it. */
const optional = (check) => Object.assign((v) => (v === undefined ? null : check(v)), { optional: true });

// ---------------------------------------------------------------------------
// Event schemas. Limits are generous; rooms do the real cleaning.
// ---------------------------------------------------------------------------

const SCHEMAS = Object.freeze({
  createRoom: { name: str({ max: 100 }) },
  joinRoom: { code: str({ min: 1, max: 16 }), name: optional(str({ max: 100 })), token: optional(str({ max: 64 })) },
  leaveRoom: {},
  listRooms: {},
  pickColor: { color: str({ min: 1, max: 16 }) },
  updateSettings: { settings: flatObject({ maxKeys: 20 }) },
  kick: { playerId: str({ min: 1, max: 64 }) },
  startGame: {},
  playAgain: {},
  action: { type: str({ min: 1, max: 32 }), tileId: optional(str({ max: 64 })), amount: optional(int({ min: 0, max: 1e7 })) },
  chat: { text: str({ max: 2000 }) },
});

/** Validate `payload` against `schema`. A missing payload counts as {}. */
function validatePayload(schema, payload) {
  const input = payload === undefined || payload === null ? {} : payload;
  if (!isPlainObject(input)) return { ok: false, error: 'payload must be an object' };
  const value = {};
  for (const [field, check] of Object.entries(schema)) {
    const error = check(input[field]);
    if (error) return { ok: false, error: `${field} ${error}` };
    if (input[field] !== undefined) value[field] = input[field];
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Text cleaning
// ---------------------------------------------------------------------------

/** C0/C1 controls plus zero-width, bidi-override and line/paragraph separator characters. */
const INVISIBLE_RANGES = [[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2069], [0xfeff, 0xfeff]];
// Built from code points so the source stays plain ASCII.
const INVISIBLE = new RegExp(`[${INVISIBLE_RANGES.map(([a, b]) => `${String.fromCodePoint(a)}-${String.fromCodePoint(b)}`).join('')}]`, 'gu');

/** Strip invisible characters, collapse whitespace, trim and cut to `max` characters. */
function cleanText(raw, max) {
  if (typeof raw !== 'string') return '';
  return [...raw.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim()].slice(0, max).join('').trim();
}

function cleanName(raw) {
  return cleanText(raw, ROOM.nameMaxLength);
}

/** Room codes are case-insensitive for people typing them in. */
function normalizeCode(raw) {
  const code = String(raw).trim().toUpperCase();
  const valid = code.length === ROOM.codeLength && [...code].every((c) => ROOM.codeAlphabet.includes(c));
  return valid ? code : null;
}

module.exports = { SCHEMAS, validatePayload, cleanText, cleanName, normalizeCode, str, int, bool, optional, flatObject };
