// The three tools: task_begin, task_end, fold_recall (docs/03 §6, docs/04 §1).
// They hold no state of their own: everything is read from the session projection, and the
// only durable write is `output.presentationMeta` → tool/result.data.meta.

import { isAbsorbed } from './cuts.js'
import * as texts from './texts.js'

/** @typedef {import('./types.js').State} State */
/** @typedef {import('./types.js').Task} Task */
/** @typedef {import('./types.js').EndVerdict} EndVerdict */
/** @typedef {import('./types.js').Outcome} Outcome */
/** @typedef {import('./settings.js').Settings} Settings */
/** @typedef {import('./estimate.js').SpanEstimator} SpanEstimator */

/** Titles are capped here; docs/04 asks the model for at most 80. */
export const TITLE_MAX = 120

/** @type {ReadonlySet<string>} */
const OUTCOMES = new Set(['done', 'failed', 'abandoned'])

/**
 * @typedef {object} ToolDeps
 * @property {(session: any) => Promise<State>} stateOf read the projection for a session
 * @property {SpanEstimator} estimator
 * @property {() => Settings} settings read the live settings
 */

/**
 * @param {ToolDeps} deps
 * @returns {any[]} tool definitions, in registration order
 */
export function createTools(deps) {
  /** @type {WeakMap<object, number>} */
  const reserved = new WeakMap()

  /**
   * The next free numeric id. The projection's own counter is authoritative; the per-session
   * high-water mark only guards against a concurrent executor (the native one is sequential).
   *
   * @param {State} state
   * @param {object} session
   */
  function takeId(state, session) {
    const next = Math.max(state.nextId, reserved.get(session) ?? 1)
    reserved.set(session, next + 1)
    return `T${next}`
  }

  /** @type {any} */
  const begin = {
    name: 'task_begin',
    description: texts.TASK_BEGIN_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: { title: { type: 'string', description: texts.TASK_BEGIN_PARAMS.title } },
      required: ['title'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          title: { type: 'string' },
          parent: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          depth: { type: 'integer' },
        },
        required: ['ok', 'id', 'title', 'parent', 'depth'],
      },
      /** @param {any} _args @param {any} value */
      render(_args, value) {
        return [{ type: 'text', text: texts.renderBegin(value.id, value.parent) }]
      },
      /** @param {any} _args @param {any} value */
      presentationMeta(_args, value) {
        return { tf: 1, op: 'begin', id: value.id, title: value.title, parent: value.parent }
      },
    },
    /**
     * @param {any} args
     * @param {any} exec
     */
    async execute(args, exec) {
      assertDirect(exec, 'task_begin')
      const title = normalizeTitle(args && args.title)
      if (title === '') throw new Error(texts.failure('task_begin', texts.ERR_EMPTY_TITLE))
      const session = exec.agent.session
      const state = await deps.stateOf(session)
      const parent = state.open.length === 0 ? null : /** @type {string} */ (state.open.at(-1))
      const depth = parent === null ? 0 : state.tasks[parent] ? state.tasks[parent].depth + 1 : 0
      return { ok: true, id: takeId(state, session), title, parent, depth }
    },
  }

  /** @type {any} */
  const end = {
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
        return {
          tf: 1,
          op: 'end',
          id: value.id,
          merged: value.merged,
          verdict: value.verdict,
          outcome: value.outcome,
          estTokens: value.estTokens,
          summaryChars: value.summaryChars,
          callId: value.callId,
        }
      },
    },
    /**
     * @param {any} args
     * @param {any} exec
     */
    async execute(args, exec) {
      assertDirect(exec, 'task_end')
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
      else throw new Error(texts.failure('task_end', texts.ERR_UNKNOWN_TASK(describe(requested), open)))
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

  /** @type {any} */
  const recall = {
    name: 'fold_recall',
    description: texts.FOLD_RECALL_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: texts.FOLD_RECALL_PARAMS.task },
        fold: { type: 'integer', description: texts.FOLD_RECALL_PARAMS.fold },
        from: { type: 'integer', description: texts.FOLD_RECALL_PARAMS.from },
        to: { type: 'integer', description: texts.FOLD_RECALL_PARAMS.to },
        grep: { type: 'string', description: texts.FOLD_RECALL_PARAMS.grep },
        page: { type: 'integer', description: texts.FOLD_RECALL_PARAMS.page },
      },
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      /** @param {any} _args @param {any} value */
      render(_args, value) {
        return [{ type: 'text', text: value.text }]
      },
    },
    /**
     * @param {any} args
     * @param {any} exec
     */
    async execute(args, exec) {
      assertDirect(exec, 'fold_recall')
      const state = await deps.stateOf(exec.agent.session)
      const keys = args ? Object.keys(args).filter((key) => args[key] !== undefined) : []
      if (keys.length > 0) return { text: texts.RECALL_NOT_AVAILABLE }
      return {
        text: texts.renderFoldList(
          state.folds.map((row, i) => ({
            index: i + 1,
            taskId: row.taskId,
            title: row.taskId === null ? null : (state.tasks[row.taskId]?.title ?? null),
            count: row.shadowedCount,
            tokens: row.shadowedTokens,
          })),
        ),
      }
    },
  }

  return [begin, end, recall]
}

/**
 * The verdict of a closed task (docs/03 §6.2), in this order: absorbed, still opening,
 * below the fold floor, unusable summary, otherwise queued.
 *
 * @param {Task} task
 * @param {string} summary
 * @param {number} summaryTokens
 * @param {number} estTokens
 * @param {Settings} settings
 * @returns {EndVerdict}
 */
export function decideVerdict(task, summary, summaryTokens, estTokens, settings) {
  if (isAbsorbed(task)) return 'absorbed'
  if (task.status === 'opening') return 'below-floor'
  if (estTokens < settings.minSpanTokens) return 'below-floor'
  const unusable =
    summary.length < settings.minSummaryChars ||
    (estTokens > 0 && summaryTokens > settings.maxSummaryRatio * estTokens)
  if (!unusable) return 'queued'
  return settings.delegateEnabled ? 'delegate' : 'queued'
}

/**
 * Whitespace collapsed, newlines removed, trimmed, capped.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeTitle(raw) {
  if (typeof raw !== 'string') return ''
  return raw.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX).trim()
}

/**
 * Task tools must be called directly: a PTC nested call is `<root>:ptc:<n>`, and no
 * `tool/result` is appended there, so its meta would never reach the projection.
 *
 * @param {any} exec
 * @param {string} tool
 */
function assertDirect(exec, tool) {
  if (!exec || typeof exec.callId !== 'string' || typeof exec.rootCallId !== 'string')
    throw new Error(texts.failure(tool, texts.ERR_UNAVAILABLE))
  if (exec.callId !== exec.rootCallId) throw new Error(texts.failure(tool, texts.ERR_NESTED(tool)))
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function describe(value) {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? '?')
}
