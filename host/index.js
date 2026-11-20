// The plugin object (docs/02-host-api.md §1). It registers the projection, the three tools, the
// prompt section and the two fold boundaries (docs/03 §5).

import { createFoldEngine } from './engine-adapter.js'
import { SpanEstimator } from './estimate.js'
import { createFoldRunner } from './fold-runner.js'
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
/** Said once when the compaction engine cannot be built (03 §11). */
export const ENGINE_UNAVAILABLE = 'the compaction engine is unavailable, so folds are off.'

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

    // The engine is built once, in the background, so the first boundary that folds does not pay
    // for the module resolution. A null engine keeps the plugin working without folds (§11).
    const engine = createFoldEngine(ctx)
    engine.then(
      (resolved) => {
        if (resolved === null)
          ctx.logger.warn(
            `${PLUGIN_NAME}: ${ENGINE_UNAVAILABLE} Tasks still open and close; folds are skipped.`,
          )
      },
      (/** @type {unknown} */ error) => {
        ctx.logger.warn(`${PLUGIN_NAME}: ${ENGINE_UNAVAILABLE} ${reason(error)}`)
      },
    )

    const runner = createFoldRunner({
      async stateOf(session) {
        if (projection.handle === undefined) throw new Error(texts.ERR_UNAVAILABLE)
        return (await projection.handle).stateOf(session)
      },
      engine: () => engine,
      estimator: new SpanEstimator(ctx.tokenMeter),
      logger: ctx.logger,
    })
    /** @param {any} payload @param {() => Promise<any>} next */
    const onPreStep = (payload, next) => runner.preStep(payload, next)
    /** @param {any} payload */
    const onTurnStopping = (payload) => runner.turnStopping(payload)
    ctx.on('agent/pre-step', onPreStep)
    ctx.on('agent/turn-stopping', onTurnStopping)
  },
}

export default plugin
