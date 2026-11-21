// The surface version (docs/10 §4.1): the epoch is part of every observation of the node list, and
// a consumer receives the two together. A replacement bumps it; nothing else may, because the epoch
// is the identity the scheduler compares a generation against (F9).
//
// Pure: no ctx, no I/O, no clock.

/** @typedef {import('./types.js').State} State */

/**
 * A projection state and the surface node list it was derived from, read together. A consumer that
 * holds a snapshot may resolve a region against it; one that compares two snapshots is comparing
 * versions, not timestamps.
 *
 * @typedef {object} SurfaceSnapshot
 * @property {State} state
 * @property {readonly number[]} nodes
 * @property {number} epoch
 */

/** The epoch a state written before the epoch existed is read at (a checkpoint from an old log). */
export const EPOCH_START = 0

/**
 * The state's surface version. A checkpoint written before the field existed reads as the start,
 * exactly as the reducer used to default it inline.
 *
 * @param {State} state
 * @returns {number}
 */
export function epochOf(state) {
  return state.surfaceEpoch ?? EPOCH_START
}

/**
 * The version after one replacement (docs/10 §4.1): the reducer bumps it even when no task was
 * touched, because a replacement that only removed a neighbouring node still changed the surface
 * another consumer may have observed.
 *
 * @param {State} state
 * @returns {number}
 */
export function nextEpoch(state) {
  return epochOf(state) + 1
}

/**
 * The state and the node list as one versioned observation (docs/10 §4.1). This is the only way a
 * consumer outside the projection gets the two, so the list can never be read without its version.
 *
 * @param {State} state
 * @param {readonly number[]} nodes
 * @returns {SurfaceSnapshot}
 */
export function snapshotOf(state, nodes) {
  return { state, nodes, epoch: epochOf(state) }
}
