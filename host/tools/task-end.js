// `task_end` (docs/03 §6, docs/04 §1): close the innermost task (or the named one), compute its
// verdict with `domain/verdict.js`, and return the value whose meta `tools/meta.js` writes.

import * as texts from '../domain/texts.js'
import { decideVerdict } from '../domain/verdict.js'
import { endMeta } from './meta.js'

/** @typedef {import('../domain/types.js').State} State */
/** @typedef {import('../domain/types.js').Task} Task */
/** @typedef {import('./index.js').ToolInternals} ToolDeps */

/** @type {ReadonlySet<string>} */
const OUTCOMES = new Set(['done', 'failed', 'abandoned'])

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
      if (open.length === 0) throw new Error(texts.failure('task_end', texts.ERR_NO_OPEN_TASK))
      let id
      if (requested === undefined || requested === null) id = open[open.length - 1]
      else if (typeof requested === 'string' && open.includes(requested)) id = requested
      else throw new Error(texts.failure('task_end', texts.ERR_UNKNOWN_TASK(deps.describe(requested), open)))
      const task = /** @type {Task} */ (state.tasks[/** @type {string} */ (id)])
      const index = open.indexOf(/** @type {string} */ (id))
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
