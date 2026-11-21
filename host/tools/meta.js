// The durable payloads the task tools write (docs/10 §9): every `tf` payload is built here, so the
// version tag and the field set have one writer. The reader is the projection's `isBeginMeta` /
// `isEndMeta` because the reducer is the only consumer that must validate a payload before it
// applies it — and `domain/` may not import `tools/`.
//
// Pure: no ctx, no I/O; the values passed in are the tool's own output values.

import { META_TAG } from '../domain/projection.js'

/** @typedef {import('../domain/types.js').BeginMeta} BeginMeta */
/** @typedef {import('../domain/types.js').EndMeta} EndMeta */

/**
 * The `data.meta` a successful `task_begin` writes (docs/03 §4.1).
 *
 * @param {{ id: string, title: string, parent: string | null }} value the tool's output value
 * @returns {BeginMeta}
 */
export function beginMeta(value) {
  return { tf: META_TAG, op: 'begin', id: value.id, title: value.title, parent: value.parent }
}

/**
 * The `data.meta` a successful `task_end` writes. The summary text itself is not copied: it already
 * lives in the closing call's arguments, inside the span, so this payload only points at it.
 *
 * @param {{ id: string, merged: string[], verdict: any, outcome: any, estTokens: number, summaryChars: number, callId: string }} value
 * @returns {EndMeta}
 */
export function endMeta(value) {
  return {
    tf: META_TAG,
    op: 'end',
    id: value.id,
    merged: value.merged,
    verdict: value.verdict,
    outcome: value.outcome,
    estTokens: value.estTokens,
    summaryChars: value.summaryChars,
    callId: value.callId,
  }
}
