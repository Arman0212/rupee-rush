'use strict';

/**
 * Minimal levelled logger. LOG_LEVEL is one of error | warn | info | debug
 * (default info). Same call shape as console, so it can be passed anywhere
 * a console-like `log` is expected.
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function createLogger(level = process.env.LOG_LEVEL || 'info') {
  const max = LEVELS[String(level).toLowerCase()] ?? LEVELS.info;
  const at = (name, write) => (LEVELS[name] <= max ? (...args) => write(...args) : () => {});
  const info = at('info', console.log);
  return {
    error: at('error', console.error),
    warn: at('warn', console.warn),
    info,
    log: info,
    debug: at('debug', console.log),
  };
}

module.exports = { createLogger, LEVELS };
