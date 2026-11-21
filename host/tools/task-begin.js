// `task_begin` (docs/03 §6, docs/04 §1): open a task and return its id. The tool holds no state of
// its own beyond a per-session id high-water mark that guards a concurrent executor; everything
// else is read from the projection, and the only durable write is the meta `tools/meta.js` builds.

import * as texts from '../domain/texts.js'
import { normalizeTitle } from '../domain/verdict.js'
import { beginMeta } from './meta.js'

/** @typedef {import('../domain/types.js').State} State */
/** @typedef {import('./index.js').ToolInternals} ToolDeps */

/**
 * @param {ToolDeps} deps
 * @returns {any} the task_begin tool definition
 */
export function createBeginTool(deps) {
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

  return {
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
        return beginMeta(value)
      },
    },
    /**
     * @param {any} args
     * @param {any} exec
     */
    async execute(args, exec) {
      deps.assertDirect(exec, 'task_begin')
      const title = normalizeTitle(args && args.title)
      if (title === '') throw new Error(texts.failure('task_begin', texts.ERR_EMPTY_TITLE))
      const session = exec.agent.session
      const state = await deps.stateOf(session)
      const parent = state.open.length === 0 ? null : /** @type {string} */ (state.open.at(-1))
      const depth = parent === null ? 0 : state.tasks[parent] ? state.tasks[parent].depth + 1 : 0
      return { ok: true, id: takeId(state, session), title, parent, depth }
    },
  }
}
