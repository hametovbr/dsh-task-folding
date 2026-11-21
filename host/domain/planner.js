// Due-task selection and region resolution (docs/03-architecture.md §5.1–5.2).
// Reads the projection state and the current surface node list; no session access.

import { ABSORBED } from './cuts.js'
import { WAITING } from './projection.js'

/** @typedef {import('./types.js').State} State */
/** @typedef {import('./types.js').Task} Task */

/**
 * @typedef {{ kind: 'fold', start: number, end: number, startIndex: number, endIndex: number }} FoldRegion
 * @typedef {{ kind: 'absorbed' } | { kind: 'empty' } | { kind: 'inconsistent', reason: string }} NoRegion
 * @typedef {FoldRegion | NoRegion} Region
 */

/**
 * Tasks whose fold may run now, inner-first: deeper tasks first, then in close order.
 * A task is due once the model has produced a message after its end batch, or when the
 * turn is stopping.
 *
 * @param {State} state
 * @param {{ turnStopping?: boolean }} [options]
 * @returns {Task[]}
 */
export function dueTasks(state, options = {}) {
  /** @type {{ task: Task, order: number }[]} */
  const due = []
  state.order.forEach((id, order) => {
    const task = state.tasks[id]
    if (!task || !WAITING.has(task.status)) return
    if (!task.reported && !options.turnStopping) return
    due.push({ task, order })
  })
  due.sort(
    (a, b) => b.task.depth - a.task.depth || closeOrder(a.task) - closeOrder(b.task) || a.order - b.order,
  )
  return due.map((d) => d.task)
}

/**
 * @param {Task} task
 * @returns {number}
 */
function closeOrder(task) {
  return task.endMsgSeq === null ? Number.MAX_SAFE_INTEGER : task.endMsgSeq
}

/**
 * Resolve a task's span to inclusive surface positions.
 *
 * @param {Task} task
 * @param {readonly number[]} nodes current surface node seqs, in surface order
 * @returns {Region}
 */
export function resolveRegion(task, nodes) {
  const { beginCut, spanStart, endCut } = task
  if (beginCut === ABSORBED || spanStart === ABSORBED || endCut === ABSORBED) return { kind: 'absorbed' }
  if (beginCut === null || endCut === null) return { kind: 'inconsistent', reason: 'cuts not set' }
  if (spanStart === null) return { kind: 'empty' }
  const beginIndex = nodes.indexOf(beginCut)
  const startIndex = nodes.indexOf(spanStart)
  const endIndex = nodes.indexOf(endCut)
  if (beginIndex === -1 || startIndex === -1 || endIndex === -1) {
    return { kind: 'inconsistent', reason: 'a boundary node is not on the surface' }
  }
  if (startIndex !== beginIndex + 1)
    return { kind: 'inconsistent', reason: 'span does not start after its begin cut' }
  if (startIndex > endIndex) return { kind: 'empty' }
  return { kind: 'fold', start: spanStart, end: endCut, startIndex, endIndex }
}
