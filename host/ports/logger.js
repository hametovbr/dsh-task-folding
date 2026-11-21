// The logging port (docs/10 §7): diagnostics never decide behaviour.
//
// A sink can throw — a broken transport, a full disk, a host logger that was replaced. If that throw
// escapes, it replaces the error being reported, breaks `agent/pre-step`, and turns a rejection
// handler into an unhandled rejection. The T3 suite found exactly that; this port is the fix.

/** @typedef {{ warn(message: string): void, info?(message: string): void, error?(message: string): void }} HostLogger */
/** @typedef {{ warn(message: string): void, info(message: string): void, error(message: string): void }} LogPort */

/**
 * Wrap a host logger so that no call can throw and a missing level is a no-op.
 *
 * @param {HostLogger | undefined | null} logger
 * @returns {LogPort}
 */
export function createLogPort(logger) {
  /**
   * @param {'warn' | 'info' | 'error'} level
   * @param {string} message
   */
  const write = (level, message) => {
    try {
      const sink = logger?.[level]
      if (typeof sink === 'function') sink.call(logger, message)
    } catch {
      // A diagnostic that fails is still only a diagnostic.
    }
  }
  return {
    warn: (message) => write('warn', message),
    info: (message) => write('info', message),
    error: (message) => write('error', message),
  }
}
