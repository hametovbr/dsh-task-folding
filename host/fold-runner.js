// Folds due tasks at step and turn boundaries (docs/03 §5.1–§5.3). Everything here is bounded
// work on the projection state plus one host transaction per fold: it never calls
// session.snapshotEvents(), never iterates the event log and never awaits an LLM.

import { dueTasks, resolveRegion } from './planner.js'
import * as texts from './texts.js'

/** @typedef {import('./types.js').State} State */
/** @typedef {import('./types.js').Task} Task */
/** @typedef {import('./planner.js').FoldRegion} FoldRegion */
/** @typedef {import('./engine-adapter.js').FoldEngine} FoldEngine */
/** @typedef {import('./engine-adapter.js').FoldRoute} FoldRoute */
/** @typedef {import('./estimate.js').SpanEstimator} SpanEstimator */

/** A pre-step slower than this means the fold work is no longer negligible. */
export const SLOW_PASS_MS = 100
/** Retry 1, 2, 4, 8 boundaries after an unexpected failure (in memory, docs/03 §5.3). */
export const MAX_BACKOFF_BOUNDARIES = 8

/**
 * @typedef {object} FoldRunnerDeps
 * @property {(session: any) => Promise<State>} stateOf
 * @property {() => Promise<FoldEngine | null>} engine resolves the engine once per process
 * @property {SpanEstimator} estimator
 * @property {{ warn: (message: string) => void, info?: (message: string) => void }} logger
 * @property {() => number} [now] clock seam
 */

/**
 * @param {FoldRunnerDeps} deps
 */
export function createFoldRunner(deps) {
  const now = deps.now ?? (() => Date.now())
  /** @type {WeakSet<object>} */
  const inFlight = new WeakSet()
  /** @type {WeakMap<object, Map<string, string>>} tasks skipped for the rest of the process */
  const skipped = new WeakMap()
  /** @type {WeakMap<object, Set<string>>} tasks already logged as waiting for another compaction */
  const waiting = new WeakMap()
  /** @type {WeakMap<object, Map<string, { failures: number, until: number }>>} */
  const backoff = new WeakMap()
  let boundary = 0

  /**
   * One boundary pass. Returns the pass outcome for tests: how many folds committed and whether
   * the pass stopped on a busy lock.
   *
   * @param {any} agent
   * @param {AbortSignal | undefined} signal
   * @param {boolean} turnStopping
   * @returns {Promise<{ folded: number, busy: boolean, skipped: string[] }>}
   */
  async function pass(agent, signal, turnStopping) {
    const session = agent.session
    /** @type {{ folded: number, busy: boolean, skipped: string[] }} */
    const report = { folded: 0, busy: false, skipped: [] }
    if (inFlight.has(session)) return report
    inFlight.add(session)
    boundary += 1
    try {
      const engine = await deps.engine()
      if (engine === null) return report
      let state = await deps.stateOf(session)
      for (const due of dueTasks(state, { turnStopping })) {
        // Re-read the task: a fold committed for an inner task moved this one's cuts.
        let task = state.tasks[due.id]
        // `delegate` tasks wait for M5: their summary has to be generated first.
        if (!task || task.status !== 'queued') continue
        if (skippedFor(session, task.id) !== undefined) continue
        if (backingOff(session, task.id)) continue
        let outcome = await foldOne(agent, session, task, state, engine, signal)
        if (outcome === 'busy') {
          // Another transaction holds the durable compaction lock, and such a transaction usually
          // commits in milliseconds. Re-read the projection and retry the same task once: the
          // retry through the engine is the lock check, so the runner never looks at the log for
          // the matching `compaction/end`.
          await Promise.resolve()
          state = await deps.stateOf(session)
          task = state.tasks[due.id]
          // The other transaction may have shadowed the span meanwhile; then there is nothing left.
          if (!task || task.status !== 'queued') continue
          outcome = await foldOne(agent, session, task, state, engine, signal)
          if (outcome === 'busy') {
            // The lock is genuinely held: stop the pass and let the next boundary retry the task.
            report.busy = true
            waitOnce(session, due.id)
            break
          }
        }
        if (outcome === 'folded') report.folded += 1
        if (outcome === 'skipped') report.skipped.push(due.id)
        // A committed fold moves the outer tasks' cuts, so re-read the state before the next one.
        if (outcome === 'folded' || outcome === 'skipped') state = await deps.stateOf(session)
      }
      return report
    } finally {
      inFlight.delete(session)
    }
  }

  /**
   * @param {any} agent
   * @param {any} session
   * @param {Task} task
   * @param {State} state
   * @param {FoldEngine} engine
   * @param {AbortSignal | undefined} signal
   * @returns {Promise<'folded' | 'busy' | 'skipped' | 'deferred'>}
   */
  async function foldOne(agent, session, task, state, engine, signal) {
    const region = resolveRegion(task, session.surface.nodes)
    if (region.kind !== 'fold') {
      if (region.kind === 'inconsistent') {
        skipOnce(session, task.id, `region is inconsistent: ${region.reason}`)
        return 'skipped'
      }
      if (region.kind === 'absorbed') {
        skipOnce(session, task.id, 'region was absorbed by another replacement')
        return 'skipped'
      }
      return 'deferred'
    }
    if (!balanced(engine, session, region)) {
      skipOnce(session, task.id, 'region is not tool-pairing balanced')
      return 'skipped'
    }
    const summary = summaryOf(session, task)
    if (summary === null || summary.trim() === '') {
      skipOnce(session, task.id, 'the task_end call carries no usable summary')
      return 'skipped'
    }
    const tokens = regionTokens(session, region)
    const nodeText = texts.renderFoldNode(task, summary, {
      messages: region.endIndex - region.startIndex + 1,
      tokens,
    })
    if (deps.estimator.text(nodeText) >= tokens) {
      skipOnce(session, task.id, `the fold node (~${tokens} tokens of span) would not be smaller`)
      return 'skipped'
    }
    try {
      await engine.foldRegion(
        agent,
        region.start,
        region.end,
        [{ type: 'text', text: nodeText }],
        routeOf(state, session, agent),
        signal,
      )
      return 'folded'
    } catch (error) {
      const kind = engine.classify(error)
      if (kind === 'busy') return 'busy'
      if (kind === 'summary') {
        skipOnce(session, task.id, 'the host refused the fold as not smaller than the span')
        return 'skipped'
      }
      retryLater(session, task.id, error)
      return 'deferred'
    }
  }

  /**
   * @param {FoldEngine} engine
   * @param {any} session
   * @param {FoldRegion} region
   */
  function balanced(engine, session, region) {
    try {
      return engine.balancedBefore(session, region.start) && engine.balancedAfter(session, region.end)
    } catch {
      return false
    }
  }

  /** @param {Task} task @param {any} session */
  function summaryOf(session, task) {
    if (task.endMsgSeq === null || task.endCallId === null) return null
    const event = session.eventAt(task.endMsgSeq)
    const content = event && event.data && event.data.message ? event.data.message.content : undefined
    if (!Array.isArray(content)) return null
    for (const block of content) {
      if (!block || block.type !== 'tool-call' || block.id !== task.endCallId) continue
      try {
        const args = JSON.parse(block.arguments)
        return args && typeof args.summary === 'string' ? args.summary : null
      } catch {
        return null
      }
    }
    return null
  }

  /** @param {any} session @param {FoldRegion} region */
  function regionTokens(session, region) {
    return deps.estimator.regionTokens(session, session.surface.nodes, region.startIndex, region.endIndex)
  }

  /**
   * The provider/model the session was last routed to, so the fold's recorded route matches the
   * conversation (docs/03 §5.3 step 5).
   *
   * @param {State} state
   * @param {any} session
   * @param {any} agent
   * @returns {FoldRoute}
   */
  function routeOf(state, session, agent) {
    const fallback = {
      provider: agent && agent.options && agent.options.provider ? agent.options.provider : '',
      model: agent && agent.options && agent.options.model ? agent.options.model : '',
    }
    if (state.lastHeaderSeq === null) return fallback
    const event = session.eventAt(state.lastHeaderSeq)
    const config = event && event.data && event.data.header ? event.data.header.config : undefined
    if (!config || typeof config.provider !== 'string' || typeof config.model !== 'string') return fallback
    return { provider: config.provider, model: config.model }
  }

  /**
   * @param {any} session
   * @param {string} taskId
   * @param {string} reason
   */
  function skipOnce(session, taskId, reason) {
    const map = skipped.get(session) ?? new Map()
    if (map.has(taskId)) return
    map.set(taskId, reason)
    skipped.set(session, map)
    deps.logger.warn(`task-folding: folding ${taskId} is skipped for this process: ${reason}`)
  }

  /**
   * @param {any} session
   * @param {string} taskId
   */
  function skippedFor(session, taskId) {
    const map = skipped.get(session)
    return map === undefined ? undefined : map.get(taskId)
  }

  /**
   * A busy lock is not an error, but a task that waits silently for the whole process is
   * unobservable, so the first give-up is explained once per task. In memory only: a restart is a
   * new chance to explain it, and a permanently held lock logs exactly one line.
   *
   * @param {any} session
   * @param {string} taskId
   */
  function waitOnce(session, taskId) {
    const ids = waiting.get(session) ?? new Set()
    if (ids.has(taskId)) return
    ids.add(taskId)
    waiting.set(session, ids)
    deps.logger.warn(
      `task-folding: folding ${taskId} waits: the compaction lock is held by another compaction`,
    )
  }

  /** @param {any} session @param {string} taskId */
  function backingOff(session, taskId) {
    const record = backoff.get(session)?.get(taskId)
    return record !== undefined && record.until > boundary
  }

  /**
   * @param {any} session
   * @param {string} taskId
   * @param {unknown} error
   */
  function retryLater(session, taskId, error) {
    const map = backoff.get(session) ?? new Map()
    const record = map.get(taskId) ?? { failures: 0, until: boundary }
    record.failures += 1
    record.until = boundary + Math.min(2 ** (record.failures - 1), MAX_BACKOFF_BOUNDARIES)
    map.set(taskId, record)
    backoff.set(session, map)
    const message = error instanceof Error ? error.message : String(error)
    deps.logger.warn(
      `task-folding: folding ${taskId} failed (attempt ${record.failures}), retrying in ${record.until - boundary} boundaries: ${message}`,
    )
  }

  /**
   * @param {any} payload
   * @param {boolean} turnStopping
   */
  async function guarded(payload, turnStopping) {
    if (!payload || !payload.agent || !payload.agent.session) return
    const started = now()
    try {
      await pass(payload.agent, payload.signal, turnStopping)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      deps.logger.warn(`task-folding: fold pass failed: ${message}`)
    } finally {
      const elapsed = now() - started
      if (elapsed > SLOW_PASS_MS)
        deps.logger.warn(`task-folding: fold pass took ${elapsed} ms (budget ${SLOW_PASS_MS} ms)`)
    }
  }

  return {
    /**
     * The `agent/pre-step` waterfall handler: fold, then hand back the host's own decision.
     *
     * @param {any} payload
     * @param {() => Promise<any>} next
     */
    async preStep(payload, next) {
      await guarded(payload, false)
      return next()
    },
    /**
     * The `agent/turn-stopping` handler: fold what is due even if no report followed the close.
     *
     * @param {any} payload
     */
    async turnStopping(payload) {
      await guarded(payload, true)
    },
    /** Exposed for tests: one boundary pass. */
    pass,
    /** Exposed for tests: the current boundary counter. */
    boundary: () => boundary,
  }
}
