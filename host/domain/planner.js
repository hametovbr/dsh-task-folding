// Due-task selection and region resolution (docs/03-architecture.md §5.1–5.2).
// Reads the projection state and the current surface node list; no session access.

import { ABSORBED } from './cuts.js'
import { WAITING } from './projection.js'

/** @typedef {import('./types.js').State} State */
/** @typedef {import('./types.js').Task} Task */
/** @typedef {import('./settings.js').Settings} Settings */
/** @typedef {import('./estimate.js').SpanEstimator} SpanEstimator */

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

/**
 * The span of the turn that just ended without a fold (docs/03 §5.6, docs/07 Q10): from the first
 * surface node after the latest turn boundary through the last node of the surface.
 *
 * The rule answers null unless all of the following hold:
 *
 * - (a) no task is open;
 * - (b) no replacement touched a live task in this turn (`state.turnFolded`) and no closed task is
 *   still waiting for its own fold — folding the turn around a waiting task would swallow it;
 * - (c) the span clears `minSpanTokens`, priced with the same host meter and floor the task path
 *   uses (the estimator is injected, as it is for `decideVerdict`, so the rule stays pure);
 * - (d) `settings.implicitTurnFold` is on;
 *
 * and the turn has a boundary that still has a position on the surface (`turnStartSeq` not null and
 * not `ABSORBED`) and the span holds at least one node.
 *
 * @param {State} state
 * @param {import('./estimate.js').SessionLike} session
 * @param {Settings} settings
 * @param {SpanEstimator} estimator
 * @returns {{ startSeq: number, endSeq: number } | null}
 */
export function implicitTurnSpan(state, session, settings, estimator) {
  const start = state.turnStartSeq
  if (start === null || start < 0) return null
  const nodes = session.surface.nodes
  const startIndex = nodes.indexOf(start)
  if (startIndex === -1) return null
  const endIndex = nodes.length - 1
  if (endIndex < startIndex) return null
  // (a) and (b): nothing the turn's own fold could shadow is still owed to a task.
  if (state.open.length > 0) return null
  if (state.turnFolded) return null
  for (const id of state.order) {
    const task = state.tasks[id]
    if (task && WAITING.has(task.status)) return null
  }
  // (d) before (c): the floor costs a host estimation pass over the span, and a disabled rule must
  // not pay for it.
  if (!settings.implicitTurnFold) return null
  if (estimator.regionTokens(session, nodes, startIndex, endIndex) < settings.minSpanTokens) return null
  return { startSeq: start, endSeq: /** @type {number} */ (nodes[endIndex]) }
}
