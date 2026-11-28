// `task_end` (docs/03 §6, docs/04 §1): close the innermost task (or the named one), compute its
// verdict with `domain/verdict.js`, and return the value whose meta `tools/meta.js` writes.

import * as texts from '../domain/texts.js'
import { TERMINAL } from '../domain/projection.js'
import { decideVerdict } from '../domain/verdict.js'
import { endMeta } from './meta.js'

/** @typedef {import('../domain/types.js').State} State */
/** @typedef {import('../domain/types.js').Task} Task */
/** @typedef {import('./index.js').ToolInternals} ToolDeps */

/** @type {ReadonlySet<string>} */
const OUTCOMES = new Set(['done', 'failed', 'abandoned'])

/**
 * What a task_end that names a task the projection already closed must answer: the state the log
 * holds, so the model learns what to do next (docs/07 Q17). A terminal task gets its status text; a
 * task that is closed but still waiting for its fold gets the waiting text.
 *
 * @param {Task} task
 * @returns {Error}
 */
function alreadyClosed(task) {
  // A folded task always carries the row it landed in: the projection sets the status and the index
  // in one transition, so the 1-based fold number is that index plus one.
  const fold = /** @type {number} */ (task.foldIndex) + 1
  const reason = TERMINAL.has(task.status)
    ? texts.ERR_TASK_TERMINAL(task.id, task.status, fold)
    : texts.ERR_TASK_WAITING(task.id)
  return new Error(texts.failure('task_end', reason))
}

/**
 * @param {ToolDeps} deps
 * @returns {any} the task_end tool definition
 */
export function createEndTool(deps) {
  return {
    name: 'task_end',
    description: texts.TASK_END_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: texts.TASK_END_PARAMS.summary },
        id: { type: 'string', description: texts.TASK_END_PARAMS.id },
        outcome: {
          type: 'string',
          enum: ['done', 'failed', 'abandoned'],
          description: texts.TASK_END_PARAMS.outcome,
        },
      },
      required: ['summary'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          verdict: { type: 'string', enum: ['queued', 'delegate', 'below-floor', 'absorbed'] },
          merged: { type: 'array', items: { type: 'string' } },
          remaining: { type: 'array', items: { type: 'string' } },
          estTokens: { type: 'integer' },
          summaryChars: { type: 'integer' },
          outcome: { type: 'string', enum: ['done', 'failed', 'abandoned'] },
          callId: { type: 'string' },
        },
        required: [
          'ok',
          'id',
          'verdict',
          'merged',
          'remaining',
          'estTokens',
          'summaryChars',
          'outcome',
          'callId',
        ],
      },
      /** @param {any} _args @param {any} value */
      render(_args, value) {
        return [
          { type: 'text', text: texts.renderEnd(value.id, value.verdict, value.merged, value.remaining) },
        ]
      },
      /** @param {any} _args @param {any} value */
      presentationMeta(_args, value) {
        return endMeta(value)
      },
    },
    /**
     * @param {any} args
     * @param {any} exec
     */
    async execute(args, exec) {
      deps.assertDirect(exec, 'task_end')
      const summary = args && typeof args.summary === 'string' ? args.summary : ''
      const outcome = args && args.outcome === undefined ? 'done' : args && args.outcome
      if (typeof outcome !== 'string' || !OUTCOMES.has(outcome))
        throw new Error(texts.failure('task_end', texts.ERR_BAD_OUTCOME))
      const session = exec.agent.session
      const state = await deps.stateOf(session)
      const open = state.open
      const requested = args ? args.id : undefined
      // Resolve the target before the open-stack guard (docs/07 Q17): a repeated task_end names a
      // task the projection already closed, and it must answer with that state — "no task is open"
      // was about a different condition and left the model with nothing to act on.
      /** @type {string} */
      let id
      if (requested !== undefined && requested !== null) {
        if (typeof requested !== 'string' || !open.includes(requested)) {
          const closed = typeof requested === 'string' ? state.tasks[requested] : undefined
          if (closed) throw alreadyClosed(closed)
          throw new Error(texts.failure('task_end', texts.ERR_UNKNOWN_TASK(deps.describe(requested), open)))
        }
        id = requested
      } else if (open.length > 0) {
        id = /** @type {string} */ (open[open.length - 1])
      } else {
        // Unnamed and nothing open: answering by status is unambiguous only while the session holds
        // a single task, so every other case keeps the generic refusal.
        const onlyId = state.order.length === 1 ? state.order[0] : undefined
        const only = onlyId === undefined ? undefined : state.tasks[onlyId]
        if (only) throw alreadyClosed(only)
        throw new Error(texts.failure('task_end', texts.ERR_NO_OPEN_TASK))
      }
      const task = /** @type {Task} */ (state.tasks[id])
      const index = open.indexOf(id)
      const merged = open.slice(index + 1)
      const estTokens = task.status === 'opening' ? 0 : deps.estimator.span(session, task)
      const config = deps.settings()
      const verdict = decideVerdict(task, summary, deps.estimator.text(summary), estTokens, config)
      return {
        ok: true,
        id,
        verdict,
        merged,
        remaining: open.slice(0, index),
        estTokens: verdict === 'absorbed' ? -1 : estTokens,
        summaryChars: summary.length,
        outcome,
        callId: exec.callId,
      }
    },
  }
}
