// Folds due tasks at step and turn boundaries (docs/03 §5.1–§5.4). Everything here is bounded
// work on the projection state plus one host transaction per fold: it never calls
// session.snapshotEvents(), never iterates the event log and never awaits an LLM. A delegate
// summary is generated in an un-awaited background promise and committed at a later boundary
// (docs/adr/0006-background-delegate.md).

import { dueTasks, resolveRegion } from './planner.js'
import * as texts from './texts.js'

/** @typedef {import('./types.js').State} State */
/** @typedef {import('./types.js').Task} Task */
/** @typedef {import('./planner.js').FoldRegion} FoldRegion */
/** @typedef {import('./planner.js').Region} Region */
/** @typedef {import('./engine-adapter.js').FoldEngine} FoldEngine */
/** @typedef {import('./engine-adapter.js').FoldRoute} FoldRoute */
/** @typedef {import('./estimate.js').SpanEstimator} SpanEstimator */

/**
 * A fold region plus the key the runner computed for it before starting a delegate generation.
 *
 * @typedef {FoldRegion & { regionKey: string }} DelegateRegion
 */

/**
 * The delegate summarizer seam (host/summarizer.js). It is injected so this module stays testable
 * without the real summarizer and so the plugin works when none can be built.
 *
 * @typedef {object} DelegateGeneration
 * @property {() => boolean} supports whether this process can build a summarizer
 * @property {(agent: any, task: Task, region: DelegateRegion, signal: AbortSignal | undefined) => Promise<{ blocks: any[], regionKey: string, usage?: any } | null>} start
 *   starts the un-awaited generation; resolves the prepared blocks or null when no usable summary
 *   was produced
 */

/** A generated summary waiting for the next boundary to commit it. */
/** @typedef {{ blocks: any[], regionKey: string, usage?: any }} PendingSummary */

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
 * @property {DelegateGeneration} [delegate] the background summarizer; without it delegate tasks
 *   wait exactly as they did before the delegate path existed
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
  /** @type {WeakMap<object, Map<string, PendingSummary>>} generated summaries waiting for a commit */
  const pending = new WeakMap()
  /** @type {WeakMap<object, Map<string, Promise<void>>>} generations in flight (one per session) */
  const generating = new WeakMap()
  /** @type {WeakMap<object, Set<string>>} generations that ended without a summary */
  const generationFailed = new WeakMap()
  /** @type {WeakMap<object, Set<string>>} tasks whose failed-generation record was already logged */
  const rejectLogged = new WeakMap()
  /** @type {'unknown' | 'yes' | 'no'} */
  let delegateSupport = 'unknown'
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
      const due = dueTasks(state, { turnStopping })
      // Phase 1 — start at most one delegate generation before this pass folds anything. The
      // summarizer must replay the surface the last main request saw, so a fold committed earlier
      // in this pass would break its prefix cache (docs/03 §5.4, docs/adr/0006).
      startDelegate(agent, session, due, state, engine, signal)
      // Phase 2 — commit generated summaries and self folds, inner-first.
      for (const entry of due) {
        // Re-read the task: a fold committed for an inner task moved this one's cuts.
        let task = state.tasks[entry.id]
        if (!task) continue
        // A generated summary for a task that can no longer fold is dead weight; drop it before it
        // shadows a later attempt.
        if (task.status !== 'delegate' && pendingFor(session, task.id) !== undefined)
          dropPending(session, task.id)
        if (task.status !== 'queued' && task.status !== 'delegate') {
          takeGenerationFailure(session, task.id)
          continue
        }
        if (skippedFor(session, task.id) !== undefined) {
          takeGenerationFailure(session, task.id)
          dropPending(session, task.id)
          continue
        }
        if (takeGenerationFailure(session, task.id)) {
          // A generation ended without a summary. Record the failure durably at this boundary and
          // let the next boundary try again; it is never retried in this pass (docs/03 §5.4).
          if (task.status === 'delegate') {
            if (await recordFailure(agent, session, task, engine, signal)) state = await deps.stateOf(session)
          }
          continue
        }
        if (backingOff(session, task.id)) continue
        let outcome = await stepTask(agent, session, task, state, engine, signal)
        if (outcome === 'busy') {
          // Another transaction holds the durable compaction lock, and such a transaction usually
          // commits in milliseconds. Re-read the projection and retry the same task once: the
          // retry through the engine is the lock check, so the runner never looks at the log for
          // the matching `compaction/end`.
          await Promise.resolve()
          state = await deps.stateOf(session)
          task = state.tasks[entry.id]
          // The other transaction may have shadowed the span meanwhile; then there is nothing left.
          if (!task || (task.status !== 'queued' && task.status !== 'delegate')) continue
          outcome = await stepTask(agent, session, task, state, engine, signal)
          if (outcome === 'busy') {
            // The lock is genuinely held: stop the pass and let the next boundary retry the task.
            report.busy = true
            waitOnce(session, entry.id)
            break
          }
        }
        if (outcome === 'folded') report.folded += 1
        if (outcome === 'skipped') report.skipped.push(entry.id)
        // A committed fold moves the outer tasks' cuts, so re-read the state before the next one.
        if (outcome === 'folded' || outcome === 'skipped') state = await deps.stateOf(session)
      }
      prunePending(session, state)
      return report
    } finally {
      inFlight.delete(session)
    }
  }

  /**
   * Dispatch one due task to its path: a delegate task commits or waits, a queued task self-folds.
   *
   * @param {any} agent
   * @param {any} session
   * @param {Task} task
   * @param {State} state
   * @param {FoldEngine} engine
   * @param {AbortSignal | undefined} signal
   * @returns {Promise<'folded' | 'busy' | 'skipped' | 'deferred'>}
   */
  function stepTask(agent, session, task, state, engine, signal) {
    return task.status === 'delegate'
      ? delegateStep(agent, session, task, state, engine, signal)
      : foldOne(agent, session, task, state, engine, signal)
  }

  /**
   * Phase 1 of the two-phase delegate fold: start at most one background generation for a due
   * delegate task, before this pass commits any fold that would change the surface under it. The
   * promise is stored and never awaited here; starting costs O(1) (docs/03 §5.4).
   *
   * @param {any} agent
   * @param {any} session
   * @param {readonly Task[]} due
   * @param {State} state
   * @param {FoldEngine} engine
   * @param {AbortSignal | undefined} signal
   */
  function startDelegate(agent, session, due, state, engine, signal) {
    if (anyGenerationInFlight(session) || !delegateSupported()) return
    for (const dueTask of due) {
      const task = state.tasks[dueTask.id]
      if (!task || task.status !== 'delegate') continue
      if (pendingFor(session, task.id) !== undefined) continue
      // A failed generation is recorded durably before the task is retried, never instead of it.
      if (generationInFailure(session, task.id)) continue
      if (skippedFor(session, task.id) !== undefined) continue
      if (backingOff(session, task.id)) continue
      // Never hand `start` a region the surface does not have: the generated text must describe
      // the span as it is now, and a task that can no longer fold must not be billed.
      const region = resolveRegion(task, session.surface.nodes)
      if (region.kind !== 'fold') continue
      if (!balanced(engine, session, region)) continue
      startGeneration(agent, session, task, region, signal)
      return
    }
  }

  /**
   * @param {any} agent
   * @param {any} session
   * @param {Task} task
   * @param {FoldRegion} region
   * @param {AbortSignal | undefined} signal
   */
  function startGeneration(agent, session, task, region, signal) {
    const delegate = deps.delegate
    if (delegate === undefined) return
    const regionKey = regionKeyOf(region, session.surface.nodes)
    /** @type {DelegateRegion} */
    const request = { ...region, regionKey }
    // Promise.resolve() defers start() by one microtask so the in-flight entry below exists even
    // when the generator throws synchronously; the rejection handler keeps the promise from
    // surfacing as an unhandled rejection.
    const generation = Promise.resolve()
      .then(() => delegate.start(agent, task, request, signal))
      .then(
        (result) => {
          if (result === null) markGenerationFailed(session, task.id)
          else
            rememberPending(session, task.id, {
              blocks: result.blocks,
              ...(result.usage === undefined ? {} : { usage: result.usage }),
              // The runner owns the key: it resolved the window, so a value echoed by the
              // summarizer can never make a commit compare against a window it did not describe.
              regionKey,
            })
          forgetGeneration(session, task.id)
        },
        (error) => {
          // A cancelled generation is not a failed attempt: the turn was interrupted, nothing was
          // generated, and counting it would push a task to `failed` for work that never ran. The
          // task simply waits for the next boundary.
          if (signal?.aborted === true) {
            log('warn', `task-folding: the delegate summary for ${task.id} was cancelled with the turn`)
            forgetGeneration(session, task.id)
            return
          }
          const message = error instanceof Error ? error.message : String(error)
          log('warn', `task-folding: no delegate summary for ${task.id}: ${message}`)
          markGenerationFailed(session, task.id)
          forgetGeneration(session, task.id)
        },
      )
    const map = generating.get(session) ?? new Map()
    map.set(task.id, generation)
    generating.set(session, map)
  }

  /**
   * Phase 2 for one delegate task: commit a generated summary when it still describes the region,
   * otherwise leave the task waiting for a later generation. Starting is phase 1's job, so this
   * never touches the surface between a start and its commit.
   *
   * @param {any} agent
   * @param {any} session
   * @param {Task} task
   * @param {State} state
   * @param {FoldEngine} engine
   * @param {AbortSignal | undefined} signal
   * @returns {Promise<'folded' | 'busy' | 'skipped' | 'deferred'>}
   */
  async function delegateStep(agent, session, task, state, engine, signal) {
    const summary = pendingFor(session, task.id)
    if (summary !== undefined) return commitDelegate(agent, session, task, state, engine, signal, summary)
    if (!delegateSupported()) return 'deferred'
    const region = resolveRegion(task, session.surface.nodes)
    if (region.kind !== 'fold') return noRegionOutcome(session, task, region)
    if (!balanced(engine, session, region)) {
      skipOnce(session, task.id, 'region is not tool-pairing balanced')
      return 'skipped'
    }
    return 'deferred'
  }

  /**
   * @param {any} agent
   * @param {any} session
   * @param {Task} task
   * @param {State} state
   * @param {FoldEngine} engine
   * @param {AbortSignal | undefined} signal
   * @param {PendingSummary} summary
   * @returns {Promise<'folded' | 'busy' | 'skipped' | 'deferred'>}
   */
  async function commitDelegate(agent, session, task, state, engine, signal, summary) {
    const region = resolveRegion(task, session.surface.nodes)
    if (region.kind !== 'fold') {
      // The span vanished or moved; the generated text can never describe it again.
      dropPending(session, task.id)
      return noRegionOutcome(session, task, region)
    }
    if (regionKeyOf(region, session.surface.nodes) !== summary.regionKey) {
      // The region changed while the summary was generated (another fold, the pruner, an auto
      // compaction): drop the text and generate again at a later boundary.
      dropPending(session, task.id)
      return 'deferred'
    }
    if (!balanced(engine, session, region)) {
      dropPending(session, task.id)
      skipOnce(session, task.id, 'region is not tool-pairing balanced')
      return 'skipped'
    }
    try {
      await engine.foldRegion(
        agent,
        region.start,
        region.end,
        summary.blocks,
        routeOf(state, session, agent),
        signal,
        summary.usage,
      )
      dropPending(session, task.id)
      return 'folded'
    } catch (error) {
      const kind = engine.classify(error)
      if (kind === 'busy') return 'busy'
      if (kind === 'summary') {
        dropPending(session, task.id)
        skipOnce(session, task.id, 'the host refused the fold as not smaller than the span')
        return 'skipped'
      }
      // Keep the text: an unexpected host failure is worth one more commit attempt, and
      // regenerating would bill the user again.
      retryLater(session, task.id, error)
      return 'deferred'
    }
  }

  /**
   * Record a failed generation as a zero-cost failed compaction attempt, so the host appends
   * `compaction/start` + `compaction/end { error }`: that durable row is what advances the delegate
   * failure cap across restarts (docs/03 §5.4, docs/07 Q11). The record needs a region the surface
   * still has, and a failure to write it is logged once instead of retried in a loop.
   *
   * @param {any} agent
   * @param {any} session
   * @param {Task} task
   * @param {FoldEngine} engine
   * @param {AbortSignal | undefined} signal
   * @returns {Promise<boolean>} whether the host was asked to record the failure
   */
  async function recordFailure(agent, session, task, engine, signal) {
    const region = resolveRegion(task, session.surface.nodes)
    if (region.kind !== 'fold') return false
    try {
      await engine.rejectRegion(agent, region.start, region.end, signal)
    } catch (error) {
      // The host appends compaction/end{error} and then rethrows, so a rejection here is the
      // expected outcome; anything else cannot be retried without looping.
      if (!rejectLoggedFor(session, task.id)) {
        const message = error instanceof Error ? error.message : String(error)
        log('warn', `task-folding: could not record the failed delegate attempt for ${task.id}: ${message}`)
      }
    }
    return true
  }

  /**
   * What to do with a task whose region the planner refused; shared by both fold paths.
   *
   * @param {any} session
   * @param {Task} task
   * @param {Region} region
   * @returns {'skipped' | 'deferred'}
   */
  function noRegionOutcome(session, task, region) {
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

  /**
   * Identifies the surface window a generated summary was written for: the boundary seqs, their
   * surface positions and the surface length (a replacement can keep both boundaries while changing
   * what sits between them). A change anywhere invalidates the text (docs/03 §5.4).
   *
   * @param {FoldRegion} region
   * @param {readonly number[]} nodes
   * @returns {string}
   */
  function regionKeyOf(region, nodes) {
    // The key describes the REGION, not the surface: the model keeps appending messages while a
    // summary is generated, and a node added after the region changes neither its edges nor the
    // span. Only a replacement that moves or shadows the span makes the generated text stale.
    /** @type {string[]} */
    const seqs = []
    for (let i = region.startIndex; i <= region.endIndex; i++) seqs.push(String(nodes[i]))
    return `${region.start}:${region.end}:${seqs.join(',')}`
  }

  /**
   * Forget generated text for tasks that can no longer fold. A task that became terminal without
   * being due again (an external compaction covered its span) would otherwise hold its blocks in
   * memory for the whole session.
   *
   * @param {any} session
   * @param {State} state
   */
  function prunePending(session, state) {
    const map = pending.get(session)
    if (map === undefined) return
    for (const taskId of [...map.keys()]) {
      const task = state.tasks[taskId]
      if (!task || (task.status !== 'queued' && task.status !== 'delegate')) map.delete(taskId)
    }
  }

  /**
   * Logging is diagnostics, not logic: a logger that throws (a broken transport, a full sink) must
   * not replace the error being reported, must not escape `agent/pre-step`, and must not turn into
   * an unhandled rejection. Nothing in the fold path may depend on it succeeding.
   *
   * @param {'warn' | 'info'} level
   * @param {string} message
   */
  function log(level, message) {
    try {
      const write = deps.logger[level]
      if (typeof write === 'function') write(message)
    } catch {
      // Swallowed on purpose: see above.
    }
  }

  /** @param {any} session @param {string} taskId @returns {PendingSummary | undefined} */
  function pendingFor(session, taskId) {
    const map = pending.get(session)
    return map === undefined ? undefined : map.get(taskId)
  }

  /** @param {any} session @param {string} taskId @param {PendingSummary} summary */
  function rememberPending(session, taskId, summary) {
    const map = pending.get(session) ?? new Map()
    map.set(taskId, summary)
    pending.set(session, map)
  }

  /** @param {any} session @param {string} taskId */
  function dropPending(session, taskId) {
    pending.get(session)?.delete(taskId)
  }

  /** @param {any} session @returns {boolean} */
  function anyGenerationInFlight(session) {
    const map = generating.get(session)
    return map !== undefined && map.size > 0
  }

  /** @param {any} session @param {string} taskId */
  function forgetGeneration(session, taskId) {
    const map = generating.get(session)
    if (map === undefined) return
    map.delete(taskId)
    if (map.size === 0) generating.delete(session)
  }

  /** @param {any} session @param {string} taskId */
  function markGenerationFailed(session, taskId) {
    const ids = generationFailed.get(session) ?? new Set()
    ids.add(taskId)
    generationFailed.set(session, ids)
  }

  /** @param {any} session @param {string} taskId @returns {boolean} */
  function generationInFailure(session, taskId) {
    const ids = generationFailed.get(session)
    return ids !== undefined && ids.has(taskId)
  }

  /** @param {any} session @param {string} taskId @returns {boolean} */
  function takeGenerationFailure(session, taskId) {
    const ids = generationFailed.get(session)
    if (ids === undefined || !ids.has(taskId)) return false
    ids.delete(taskId)
    if (ids.size === 0) generationFailed.delete(session)
    return true
  }

  /**
   * @param {any} session
   * @param {string} taskId
   * @returns {boolean} whether the record attempt was already logged for this task
   */
  function rejectLoggedFor(session, taskId) {
    const ids = rejectLogged.get(session) ?? new Set()
    if (ids.has(taskId)) return true
    ids.add(taskId)
    rejectLogged.set(session, ids)
    return false
  }

  /** @returns {boolean} whether this process can build the delegate summarizer */
  function delegateSupported() {
    const delegate = deps.delegate
    if (delegate === undefined) return false
    if (delegateSupport === 'unknown') {
      // A summarizer cannot be built later in the process (the LLM service is injected once), so
      // one probe is enough; a false answer leaves delegate tasks waiting as they did before M5.
      try {
        delegateSupport = delegate.supports() ? 'yes' : 'no'
      } catch {
        delegateSupport = 'no'
      }
    }
    return delegateSupport === 'yes'
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
    if (region.kind !== 'fold') return noRegionOutcome(session, task, region)
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
    log('warn', `task-folding: folding ${taskId} is skipped for this process: ${reason}`)
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
    log('warn', `task-folding: folding ${taskId} waits: the compaction lock is held by another compaction`)
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
    log(
      'warn',
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
      log('warn', `task-folding: fold pass failed: ${message}`)
    } finally {
      const elapsed = now() - started
      if (elapsed > SLOW_PASS_MS)
        log('warn', `task-folding: fold pass took ${elapsed} ms (budget ${SLOW_PASS_MS} ms)`)
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
