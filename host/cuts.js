// Cut translation (docs/03-architecture.md §2.4). Pure.

/** @typedef {import('./types.js').Task} Task */
/** @typedef {import('./types.js').ReplaceOp} ReplaceOp */

export const ABSORBED = -1

/**
 * Where a boundary that sits right after node `seq` ends up after a replacement.
 * The boundary survives only when `seq` was the last shadowed node; then it moves
 * to just after the replacement node.
 *
 * @param {number | null} seq
 * @param {Set<number>} shadowed
 * @param {ReplaceOp} op
 * @param {number} replacementSeq
 * @returns {number | null}
 */
export function translateAfter(seq, shadowed, op, replacementSeq) {
  if (seq === null || seq === ABSORBED || !shadowed.has(seq)) return seq
  return seq === op.endSeq ? replacementSeq : ABSORBED
}

/**
 * Where the first node of a span ends up after a replacement. It survives only when
 * the replacement starts exactly at it; then the replacement node takes its place.
 *
 * @param {number | null} seq
 * @param {Set<number>} shadowed
 * @param {ReplaceOp} op
 * @param {number} replacementSeq
 * @returns {number | null}
 */
export function translateFirst(seq, shadowed, op, replacementSeq) {
  if (seq === null || seq === ABSORBED || !shadowed.has(seq)) return seq
  return seq === op.startSeq ? replacementSeq : ABSORBED
}

/**
 * Translate every tracked boundary of one task. Returns the same object when nothing moved.
 *
 * @param {Task} task
 * @param {Set<number>} shadowed
 * @param {ReplaceOp} op
 * @param {number} replacementSeq
 * @returns {Task}
 */
export function translateTask(task, shadowed, op, replacementSeq) {
  const beginCut = translateAfter(task.beginCut, shadowed, op, replacementSeq)
  const spanStart = translateFirst(task.spanStart, shadowed, op, replacementSeq)
  const endCut = translateAfter(task.endCut, shadowed, op, replacementSeq)
  if (beginCut === task.beginCut && spanStart === task.spanStart && endCut === task.endCut) return task
  return { ...task, beginCut, spanStart, endCut }
}

/**
 * @param {Task} task
 * @returns {boolean}
 */
export function isAbsorbed(task) {
  return task.beginCut === ABSORBED || task.spanStart === ABSORBED || task.endCut === ABSORBED
}
