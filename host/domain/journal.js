// The journal gateway (docs/10 §8): the one place that decides what a session event is, before the
// reducer trusts it. A log is the only input the projection has, so it can be damaged, written by
// another version of this plugin, or carry events this module knows nothing about. classify() names
// the kind once, for every consumer, instead of each handler re-deriving it from event.type; the
// projection then dispatches on the kind and keeps the per-event transitions it already owned.
//
// Pure: no ctx, no I/O, no clock.

/** @typedef {import('./types.js').SessionEvent} SessionEvent */
/** @typedef {import('./types.js').ReplaceOp} ReplaceOp */

/** The durable source kind a published hint carries on its user/message (docs/03 §8). */
export const HINT_SOURCE_KIND = 'task-folding:hint'

/** Every event type that carries a surface node and may carry a replacement (docs/02 §2). */
const SURFACE_TYPES = new Set(['system/message', 'user/message', 'assistant/message', 'tool/result'])

/**
 * What the event is, in the categories the reducer dispatches on:
 *
 * - `surface` — appends (or replaces) a surface node: messages, results, and the batch closer that
 *   a `step/end` is;
 * - `task-result` — a `tool/result`, whose meta may open or close a task;
 * - `compaction` — a `compaction/summary` or `compaction/end` row;
 * - `header` — a `request/header`;
 * - `hint` — the user/message a published hint became;
 * - `batch` — a `step/end`: no surface change, but it closes an in-flight batch;
 * - `ignore` — anything this plugin does not read.
 *
 * A replacement is a surface event whatever its `type`: `surfaceOp` is checked first, so a
 * replacement can never be read as an append.
 *
 * @param {SessionEvent} event
 * @returns {'surface' | 'task-result' | 'compaction' | 'header' | 'hint' | 'batch' | 'ignore'}
 */
export function classify(event) {
  if (replaceOp(event) !== null) return 'surface'
  switch (event.type) {
    case 'assistant/message':
    case 'system/message':
      return 'surface'
    case 'user/message':
      return isHintMessage(event) ? 'hint' : 'surface'
    case 'tool/result':
      return 'task-result'
    case 'compaction/summary':
    case 'compaction/end':
      return 'compaction'
    case 'request/header':
      return 'header'
    case 'step/end':
      return 'batch'
    default:
      return 'ignore'
  }
}

/**
 * The replacement an event commits, or null when it is an append or not a surface event at all.
 * The host describes a replacement with `surfaceOp`; a malformed one is an append, not a boundary
 * shift the reducer should trust.
 *
 * @param {SessionEvent} event
 * @returns {ReplaceOp | null}
 */
export function replaceOp(event) {
  if (!SURFACE_TYPES.has(event.type)) return null
  const op = event.surfaceOp
  if (!op || typeof op !== 'object' || op.op !== 'replace') return null
  if (typeof op.startSeq !== 'number' || typeof op.endSeq !== 'number') return null
  return op
}

/**
 * Whether the event is a user/message carrying a published hint's source. The key type is not
 * checked here: the projection validates the key it stores, and a malformed one is still a hint
 * event for dispatch purposes.
 *
 * @param {SessionEvent} event
 * @returns {boolean}
 */
function isHintMessage(event) {
  const source = event.data && event.data.source
  return Boolean(source && source.kind === HINT_SOURCE_KIND)
}
