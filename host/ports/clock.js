// The clock port (docs/10 §7): time is injected, so a test can drive it and a pass can be timed
// without reading the wall clock twice in two places.

/** @typedef {{ now(): number }} ClockPort */

/**
 * @param {() => number} [read]
 * @returns {ClockPort}
 */
export function createClock(read = () => Date.now()) {
  return { now: () => read() }
}
