// The mount of the plugin (docs/10 §3, §5): registration of the projection, the three tools, the
// prompt section and the two fold boundaries. This is the only module in `plugin/` that receives
// the host context, and even here every service is reached through `ports/host-services.js` — the
// one module that names a missing service and deactivates cleanly instead of throwing a TypeError
// halfway through a partial registration.

import { SpanEstimator } from '../domain/estimate.js'
import {
  PROJECTION_KEY,
  STATE_VERSION,
  apply as reduce,
  init as initState,
  stateSchema,
  view,
  viewSchema,
} from '../domain/projection.js'
import { readSettings } from '../domain/settings.js'
import * as texts from '../domain/texts.js'
import { createCompactionPort } from '../ports/compaction.js'
import { PLUGIN_NAME, createHostServices, loadHostModule, reason } from '../ports/host-services.js'
import { createLogPort } from '../ports/logger.js'
import {
  buildDelegateRequest,
  generateDelegateSummary,
  indexLinesFor,
  routeOfRequest,
  validateDelegateSummary,
} from '../ports/llm.js'
import { maybeHint } from '../prompt/hints.js'
import { promptSection } from '../prompt/section.js'
import { createFoldRunner } from '../runtime/scheduler.js'
import { createTools } from '../tools/index.js'
import { createPreStep } from './pre-step.js'

export { PLUGIN_NAME }

/** Output-token cap for a delegate summary: a fold is 5–10 % of its span, never a whole essay. */
export const DELEGATE_MAX_TOKENS = 2000
/** The instruction asks for at most this many tokens of summary text (docs/03 §7.2). */
export const DELEGATE_BUDGET_TOKENS = 1500
/** Said once when the compaction engine cannot be built (03 §11). */
export const ENGINE_UNAVAILABLE = 'the compaction engine is unavailable, so folds are off.'

/** The host services this plugin injects; the host refuses to mount it without them. */
export const inject = ['tools', 'sessionProjections', 'systemPrompt', 'tokenMeter']

/**
 * @param {any} ctx
 * @param {any} config resolved Config values (volatile readers) or undefined without a Config
 */
export function apply(ctx, config) {
  const services = createHostServices(ctx)
  /** @type {{ handle?: Promise<{ stateOf(session: any): any }> }} */
  const projection = {}
  const tools = createTools({
    async stateOf(session) {
      if (projection.handle === undefined) throw new Error(texts.ERR_UNAVAILABLE)
      return (await projection.handle).stateOf(session)
    },
    estimator: new SpanEstimator(services.tokenMeter),
    settings: () => readSettings(config),
  })

  if (!services.registerTools(tools)) return

  // The projection is as load-bearing as the tools: without it `stateOf` cannot answer, so a
  // missing service must deactivate the plugin the same way a missing tool sink does — with one
  // line naming the service, not a TypeError thrown halfway through a partial registration.
  const handle = services.registerProjection({
    key: PROJECTION_KEY,
    stateSchema,
    init: initState,
    apply: reduce,
    stateVersion: STATE_VERSION,
    wire: { viewSchema, view },
  })
  if (handle === null) return
  projection.handle = handle
  handle.catch((/** @type {unknown} */ error) => {
    services.logger.error(`${PLUGIN_NAME}: projection registration failed: ${reason(error)}`)
  })

  services.registerSection(promptSection())

  // The compaction port is built once, in the background, so the first boundary that folds does
  // not pay for the module resolution. A null port keeps the plugin working without folds (§11).
  const port = createCompactionPort(ctx)
  port.then(
    (resolved) => {
      if (resolved === null)
        services.logger.warn(
          `${PLUGIN_NAME}: ${ENGINE_UNAVAILABLE} Tasks still open and close; folds are skipped.`,
        )
    },
    (/** @type {unknown} */ error) => {
      services.logger.warn(`${PLUGIN_NAME}: ${ENGINE_UNAVAILABLE} ${reason(error)}`)
    },
  )

  const estimator = new SpanEstimator(services.tokenMeter)

  // The delegate path replays the main request's prefix so the provider cache keeps hitting
  // (docs/03 §12 invariant 9). `start` is never awaited by the runner.
  /** @type {any} */
  let delegateUnavailableLogged = false
  const delegate = {
    supports() {
      const available = typeof services.service('llm')?.stream === 'function'
      if (!available && !delegateUnavailableLogged) {
        delegateUnavailableLogged = true
        services.logger.warn(
          `${PLUGIN_NAME}: the LLM service is not available, so delegate summaries are off; tasks wait as before.`,
        )
      }
      return available
    },
    /**
     * @param {any} agent
     * @param {any} task
     * @param {{ start: number, end: number, startIndex: number, endIndex: number, regionKey: string }} region
     * @param {AbortSignal | undefined} signal
     */
    async start(agent, task, region, signal) {
      const session = agent.session
      const llm = services.service('llm')
      if (llm === undefined) return null
      // Settings override > the session's routed target > the agent options (docs/03 §5.4).
      const live = readSettings(config)
      const override =
        live.summarizationProvider !== '' && live.summarizationModel !== ''
          ? { provider: live.summarizationProvider, model: live.summarizationModel }
          : null
      const route =
        override ??
        routeOfRequest(session) ??
        (agent.options && agent.options.provider && agent.options.model
          ? { provider: agent.options.provider, model: agent.options.model }
          : null)
      if (route === null) return null
      const spanTokens = estimator.regionTokens(
        session,
        session.surface.nodes,
        region.startIndex,
        region.endIndex,
      )
      const request = buildDelegateRequest({ session, region })
      const instruction = texts.renderDelegateInstruction({
        index: indexLinesFor({ session, region }),
        budgetTokens: Math.min(DELEGATE_BUDGET_TOKENS, Math.max(200, Math.round(spanTokens / 10))),
      })
      const generated = await generateDelegateSummary({
        llm,
        loader: loadHostModule,
        request,
        instruction,
        route,
        maxTokens: DELEGATE_MAX_TOKENS,
        sessionId: session.id,
        toolHistory: session.toolHistory(),
        signal,
      })
      const checked = validateDelegateSummary(generated.text, {
        spanTokens,
        maxSummaryRatio: live.maxSummaryRatio,
        estimator,
      })
      // Carry the provider usage so the host records it on `compaction/summary`: that row is
      // where the plugin's cache-hit is audited (docs/03 §12 invariant 9).
      return checked.ok
        ? { blocks: checked.blocks, regionKey: region.regionKey, usage: generated.usage }
        : null
    },
  }

  const logPort = createLogPort(services.logger)
  const runner = createFoldRunner({
    async stateOf(session) {
      if (projection.handle === undefined) throw new Error(texts.ERR_UNAVAILABLE)
      return (await projection.handle).stateOf(session)
    },
    engine: () => port,
    estimator,
    log: logPort, // the port, so a throwing sink cannot break the pass
    delegate,
    // The implicit turn fold reads its switch and its floor from the live config (docs/03 §5.6).
    settings: () => readSettings(config),
  })
  // The pre-step sequence (fold → hint → decision) lives in one module, so the two handlers can
  // never disagree about what the decision is (docs/10 §5, §16 step 7).
  const onPreStep = createPreStep({
    runner,
    projection,
    settings: () => readSettings(config),
    hints: maybeHint,
  })
  /** @param {any} payload */
  const onTurnStopping = (payload) => runner.turnStopping(payload)
  services.onHook('agent/pre-step', onPreStep)
  services.onHook('agent/turn-stopping', onTurnStopping)
}
