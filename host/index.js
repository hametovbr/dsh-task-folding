// The plugin object (docs/02-host-api.md §1). It registers the projection, the three tools and
// the prompt section, and does nothing else: no hooks, no folds — those arrive in M3.

import { SpanEstimator } from './estimate.js'
import {
  PROJECTION_KEY,
  STATE_VERSION,
  apply as reduce,
  init as initState,
  stateSchema,
  view,
  viewSchema,
} from './projection.js'
import { loadSchemastery } from './resolve.js'
import { buildConfig, readSettings } from './settings.js'
import * as texts from './texts.js'
import { createTools } from './tools.js'

export const PLUGIN_NAME = 'dsh-task-folding'
export const PROMPT_ORDER = 650

/** The host's schema builder, or null when it cannot be resolved (the plugin then runs with defaults). */
const schemastery = await loadSchemastery()

/**
 * @param {unknown} error
 * @returns {string}
 */
function reason(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** @type {any} */
const plugin = {
  name: PLUGIN_NAME,
  inject: ['tools', 'sessionProjections', 'systemPrompt', 'tokenMeter'],
  ...(schemastery === null ? {} : { Config: buildConfig(schemastery) }),
  /**
   * @param {any} ctx
   * @param {any} config resolved Config values (volatile readers) or undefined without a Config
   */
  apply(ctx, config) {
    /** @type {{ handle?: Promise<{ stateOf(session: any): any }> }} */
    const projection = {}
    const tools = createTools({
      async stateOf(session) {
        if (projection.handle === undefined) throw new Error(texts.ERR_UNAVAILABLE)
        return (await projection.handle).stateOf(session)
      },
      estimator: new SpanEstimator(ctx.tokenMeter),
      settings: () => readSettings(config),
    })

    /** @type {(() => void)[]} */
    const registered = []
    try {
      for (const definition of tools) registered.push(ctx.tools.register(definition))
    } catch (error) {
      for (const dispose of registered) dispose()
      ctx.logger.warn(
        `${PLUGIN_NAME}: not activated, ${reason(error)} Uninstall dsh-taskfold and restart to use this plugin.`,
      )
      return
    }

    projection.handle = Promise.resolve(
      ctx.sessionProjections.register({
        key: PROJECTION_KEY,
        stateSchema,
        init: initState,
        apply: reduce,
        stateVersion: STATE_VERSION,
        wire: { viewSchema, view },
      }),
    )
    projection.handle.catch((/** @type {unknown} */ error) => {
      ctx.logger.error(`${PLUGIN_NAME}: projection registration failed: ${reason(error)}`)
    })

    ctx.systemPrompt.section({ name: 'task-folding', order: PROMPT_ORDER, text: texts.PROMPT_SECTION })
  },
}

export default plugin
