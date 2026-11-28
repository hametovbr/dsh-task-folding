// Folds due tasks at step and turn boundaries (docs/03 §5.1–§5.4, docs/10 §5–§6). Everything here
// is bounded work on the projection state plus one host transaction per fold: it never calls
// session.snapshotEvents(), never iterates the event log and never awaits an LLM. A delegate
// summary is started and settled by `runtime/generation.js` in an un-awaited background promise and
// committed at a later boundary (docs/adr/0006-background-delegate.md).
//
// The scheduler keeps no state of its own across boundaries except one `WeakMap<session,
// SessionRuntime>` (docs/10 §4.2). Every transition goes through the pure reducer in
// `runtime/session-runtime.js`, which refuses the ones the failure table of docs/10 §12 does not
// allow; the scheduler reads the runtime again after every `await`, so a background generation that
// settles mid-pass is never overwritten by a stale local copy.
//
// The public factory keeps the name `createFoldRunner` and the deps contract it has always had: it
// is what the tests and the plugin mount; only the file it lives in moved.

import { finalizeFoldBlocks, foldBlocksText, nodeTokensOf } from '../domain/fold-node.js'
import { dueTasks, implicitTurnSpan, resolveRegion } from '../domain/planner.js'
import { TERMINAL, WAITING } from '../domain/projection.js'
import { defaults } from '../domain/settings.js'
import { snapshotOf } from '../domain/surface.js'
import { createLogPort } from '../ports/logger.js'
import { inboundUserNodes } from './fold-context.js'
import { createGeneration } from './generation.js'
import { createSessionRuntime, isBackingOff, reduce, skipReason, taskRuntime } from './session-runtime.js'

/** @typedef {import('../domain/types.js').State} State */
/** @typedef {import('../domain/types.js').Task} Task */
/** @typedef {import('../domain/settings.js').Settings} Settings */
/** @typedef {import('../domain/planner.js').FoldRegion} FoldRegion */
/** @typedef {import('../domain/planner.js').Region} Region */
/** @typedef {import('../domain/surface.js').SurfaceSnapshot} Snapshot */
/** @typedef {import('../ports/compaction.js').CompactionPort} CompactionPort */
/** @typedef {import('../ports/compaction.js').FoldRoute} FoldRoute */
/** @typedef {import('../ports/compaction.js').SummaryResult} SummaryResult */
/** @typedef {import('../domain/estimate.js').SpanEstimator} SpanEstimator */
/** @typedef {import('./session-runtime.js').Action} Action */
/** @typedef {import('./session-runtime.js').SessionRuntime} SessionRuntime */
/** @typedef {import('./generation.js').DelegateGeneration} DelegateGeneration */

/** Retry 1, 2, 4, 8 boundaries after an unexpected fold failure (docs/03 §5.3). */
export { MAX_BACKOFF_BOUNDARIES } from './session-runtime.js'

/** A pre-step slower than this means the fold work is no longer negligible. */
export const SLOW_PASS_MS = 100

/**
 * @typedef {object} FoldRunnerDeps
 * @property {(session: any) => Promise<State>} stateOf
 * @property {() => Promise<CompactionPort | null>} engine resolves the engine once per process
 * @property {SpanEstimator} estimator
 * @property {{ warn: (message: string) => void, info?: (message: string) => void }} [logger]
 *   a raw host logger; wrapped in `ports/logger.js` so a throwing sink cannot break a pass
 * @property {import('../ports/logger.js').LogPort} [log] an already wrapped port (wins over `logger`)
 * @property {DelegateGeneration} [delegate] the background summarizer; without it delegate tasks
 *   wait exactly as they did before the delegate path existed
 * @property {() => Settings} [settings] the live settings; defaults are used when absent
 * @property {() => number} [now] clock seam
 */

/**
 * @param {FoldRunnerDeps} deps
 */
export function createFoldRunner(deps) {
  const now = deps.now ?? (() => Date.now())
  const settingsOf = deps.settings ?? (() => defaults())
  /** @type {WeakMap<object, SessionRuntime>} the only per-session state this module keeps */
  const runtimes = new WeakMap()
  /** The boundary of the most recent pass; the test accessor below. */
  let lastBoundary = 0

  // The port owns the "never throws" guarantee (docs/10 §7); the scheduler only names the level.
  // A caller may hand over a raw host logger or an already wrapped port.
  const logPort = deps.log ?? createLogPort(deps.logger)
  /**
   * @param {'warn' | 'info' | 'error'} level
   * @param {string} message
   */
  function log(level, message) {
    logPort[level](message)
  }

  /**
   * The session's runtime, created on first use. A weak key means a finished session's state is
   * collected with it, exactly as the seven WeakMaps were.
   *
   * @param {any} session
   * @returns {SessionRuntime}
   */
  function runtimeOf(session) {
    let runtime = runtimes.get(session)
    if (runtime === undefined) {
      runtime = createSessionRuntime()
      runtimes.set(session, runtime)
    }
    return runtime
  }

  /**
   * Apply one transition. The runtime is read again here, not cached by the caller, so a background
   * generation that settles across an `await` in a pass can never be overwritten by a stale copy.
   *
   * @param {any} session
   * @param {Action} action
   * @returns {{ runtime: SessionRuntime, changed: boolean }}
   */
  function apply(session, action) {
    const current = runtimeOf(session)
    const next = reduce(current, action)
    if (next !== current) runtimes.set(session, next)
    return { runtime: next, changed: next !== current }
  }

  /**
   * @param {any} session
   * @param {string} taskId
   * @returns {import('./session-runtime.js').TaskRuntime|undefined}
   */
  function taskState(session, taskId) {
    return taskRuntime(runtimeOf(session), taskId)
  }

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
    if (runtimeOf(session).busy) return report
    apply(session, { type: 'enter-pass' })
    lastBoundary = apply(session, { type: 'boundary++' }).runtime.boundary
    try {
      const engine = await deps.engine()
      if (engine === null) return report
      /** @returns {Promise<Snapshot>} */
      const reread = async () => {
        const state = await deps.stateOf(session)
        return snapshotOf(state, session.surface.nodes)
      }
      let snap = await reread()
      const due = dueTasks(snap.state, { turnStopping })
      // Phase 1 — start at most one delegate generation before this pass folds anything. The
      // summarizer must replay the surface the last main request saw, so a fold committed earlier
      // in this pass would break its prefix cache (docs/03 §5.4, docs/adr/0006).
      generation.start(agent, session, due, snap, engine, signal)
      // Starting a generation is the pass's only suspension point: the host can commit another
      // compaction while it runs and move the surface the due list was resolved against. Phase 2
      // reads the snapshot again so it never resolves a region against a stale surface (F9).
      snap = await reread()
      // Phase 2 — commit generated summaries and self folds, inner-first.
      for (const entry of due) {
        // Re-read the task: a fold committed for an inner task moved this one's cuts.
        let task = snap.state.tasks[entry.id]
        if (!task) continue
        // A skip decided at an older surface version no longer applies (docs/10 §12).
        apply(session, { type: 'unsplit-skip', taskId: entry.id, epoch: snap.epoch })
        // A generated summary for a task that can no longer fold is dead weight; drop it before it
        // shadows a later attempt.
        if (task.status !== 'delegate' && (taskState(session, entry.id)?.pending ?? null) !== null)
          apply(session, { type: 'drop-pending', taskId: entry.id })
        if (task.status !== 'queued' && task.status !== 'delegate') {
          apply(session, { type: 'record-failure', taskId: entry.id, recorded: false })
          continue
        }
        if (skipReason(taskState(session, entry.id), snap.epoch) !== undefined) {
          apply(session, { type: 'record-failure', taskId: entry.id, recorded: false })
          apply(session, { type: 'drop-pending', taskId: entry.id })
          continue
        }
        if (taskState(session, entry.id)?.failedGeneration === true) {
          // A generation ended without a summary. Record the failure durably at this boundary and
          // let the next boundary try again; it is never retried in this pass (docs/03 §5.4).
          const recorded =
            task.status === 'delegate'
              ? await generation.recordFailure(agent, session, task, engine, signal)
              : false
          apply(session, { type: 'record-failure', taskId: entry.id, recorded })
          if (recorded) snap = await reread()
          continue
        }
        if (backingOff(session, entry.id)) continue
        let outcome = await stepTask(agent, session, task, snap, engine, signal)
        if (outcome === 'busy') {
          // Another transaction holds the durable compaction lock, and such a transaction usually
          // commits in milliseconds. Re-read the projection and retry the same task once: the
          // retry through the engine is the lock check, so the scheduler never looks at the log for
          // the matching `compaction/end`.
          await Promise.resolve()
          snap = await reread()
          task = snap.state.tasks[entry.id]
          // The other transaction may have shadowed the span meanwhile; then there is nothing left.
          if (!task || (task.status !== 'queued' && task.status !== 'delegate')) continue
          outcome = await stepTask(agent, session, task, snap, engine, signal)
          if (outcome === 'busy') {
            // The lock is genuinely held: stop the pass and let the next boundary retry the task.
            report.busy = true
            waitOnce(session, entry.id, snap.epoch)
            break
          }
        }
        if (outcome === 'folded') {
          apply(session, { type: 'commit-folded', taskId: entry.id, epoch: snap.epoch })
          report.folded += 1
        }
        if (outcome === 'skipped') report.skipped.push(entry.id)
        if (outcome === 'deferred')
          apply(session, { type: 'commit-deferred', taskId: entry.id, epoch: snap.epoch })
        // A committed fold moves the outer tasks' cuts, so re-read the state before the next one.
        if (outcome === 'folded' || outcome === 'skipped') snap = await reread()
      }
      // Phase 3 — the turn's own fold (docs/03 §5.6, docs/07 Q10). A generated turn summary is
      // committed after every task fold, so it can never move a region a task fold was resolved
      // against; then a turn boundary may start the next turn's generation. The implicit fold has
      // no task and no `task_end` meta: it is recorded exactly like the host's own auto compaction.
      if (report.busy) snap = await reread()
      const implicit = await generation.commitImplicit(agent, session, snap, engine, signal)
      if (implicit === 'folded') {
        report.folded += 1
        snap = await reread()
      } else if (implicit === 'busy') {
        report.busy = true
      }
      if (turnStopping && !report.busy && generation.delegateSupported() && snap.state.turnSeq !== null) {
        // Pricing the span costs one pass over the turn with the host meter, so the rule is only
        // asked when a summarizer exists and the log has a turn boundary (docs/03 §5.6).
        const span = implicitTurnSpan(snap.state, session, settingsOf(), deps.estimator)
        if (span !== null) generation.startImplicit(agent, session, span, snap, engine, signal)
      }
      pruneTerminal(session, snap.state)
      return report
    } finally {
      apply(session, { type: 'leave-pass' })
    }
  }

  /**
   * Dispatch one due task to its path: a delegate task commits or waits, a queued task self-folds.
   *
   * @param {any} agent
   * @param {any} session
   * @param {Task} task
   * @param {Snapshot} snap
   * @param {CompactionPort} engine
   * @param {AbortSignal | undefined} signal
   * @returns {Promise<'folded' | 'busy' | 'skipped' | 'deferred'>}
   */
  function stepTask(agent, session, task, snap, engine, signal) {
    return task.status === 'delegate'
      ? generation.stepDelegate(agent, session, task, snap, engine, signal)
      : foldOne(agent, session, task, snap, engine, signal)
  }

  /**
   * What to do with a task whose region the planner refused; shared by both fold paths.
   *
   * @param {any} session
   * @param {Task} task
   * @param {Region} region
   * @param {number} epoch
   * @returns {'skipped' | 'deferred'}
   */
  function noRegionOutcome(session, task, region, epoch) {
    if (region.kind === 'inconsistent') {
      skipTask(session, task.id, epoch, `region is inconsistent: ${region.reason}`)
      return 'skipped'
    }
    if (region.kind === 'absorbed') {
      skipTask(session, task.id, epoch, 'region was absorbed by another replacement')
      return 'skipped'
    }
    return 'deferred'
  }

  /**
   * Forget private state for tasks that can no longer fold. A task that became terminal without
   * being due again (an external compaction covered its span) would otherwise hold its blocks in
   * memory for the whole session.
   *
   * @param {any} session
   * @param {State} state
   */
  function pruneTerminal(session, state) {
    /** @type {Set<string>} */
    const waiting = new Set()
    /** @type {Set<string>} */
    const terminal = new Set()
    for (const taskId of runtimeOf(session).tasks.keys()) {
      const task = state.tasks[taskId]
      if (task !== undefined && WAITING.has(task.status)) waiting.add(taskId)
      else if (task === undefined || TERMINAL.has(task.status)) terminal.add(taskId)
    }
    apply(session, { type: 'prune-terminal', waiting, terminal })
  }

  /** @param {any} session @param {string} taskId @returns {boolean} */
  function backingOff(session, taskId) {
    return isBackingOff(taskState(session, taskId), runtimeOf(session).boundary)
  }

  /**
   * @param {any} session
   * @param {string} taskId
   * @returns {boolean} whether this call claimed the one-line record-failure explanation
   */
  function claimRejectLog(session, taskId) {
    return apply(session, { type: 'claim-reject-log', taskId }).changed
  }

  /**
   * @param {any} agent
   * @param {any} session
   * @param {Task} task
   * @param {Snapshot} snap
   * @param {CompactionPort} engine
   * @param {AbortSignal | undefined} signal
   * @returns {Promise<'folded' | 'busy' | 'skipped' | 'deferred'>}
   */
  async function foldOne(agent, session, task, snap, engine, signal) {
    const region = resolveRegion(task, snap.nodes)
    if (region.kind !== 'fold') return noRegionOutcome(session, task, region, snap.epoch)
    if (!balanced(engine, session, region)) {
      skipTask(session, task.id, snap.epoch, 'region is not tool-pairing balanced')
      return 'skipped'
    }
    const summary = summaryOf(session, task)
    if (summary === null || summary.trim() === '') {
      skipTask(session, task.id, snap.epoch, 'the task_end call carries no usable summary')
      return 'skipped'
    }
    const tokens = regionTokens(session, region)
    const summaryBlocks = [{ type: 'text', text: summary }]
    /** @type {import('../domain/fold-node.js').FoldNodeInput} */
    const nodeInput = {
      inbound: inboundUserNodes(session, snap.nodes, region.startIndex, region.endIndex),
      spanTokens: tokens,
      estimator: deps.estimator,
      task: { id: task.id, title: task.title, outcome: task.outcome },
      fold: null,
      messages: region.endIndex - region.startIndex + 1,
    }
    const nodeBlocks = finalizeFoldBlocks(summaryBlocks, {
      ...nodeInput,
      nodeTokens: nodeTokensOf(summaryBlocks, nodeInput),
    })
    const nodeText = foldBlocksText(nodeBlocks)
    if (deps.estimator.text(nodeText) >= tokens) {
      skipTask(session, task.id, snap.epoch, `the fold node (~${tokens} tokens of span) would not be smaller`)
      return 'skipped'
    }
    try {
      // The model wrote this summary itself, in the closing call: the record says so, even though
      // the host records the prepared blocks unmarked (docs/10 §8). The audit line for `source` is
      // emitted for the delegate path (`runtime/generation.js`): a healthy self fold must stay
      // silent, which test/f9-surface-epoch.test.js and test/fold-runner.test.js pin.
      /** @type {SummaryResult} */
      const prepared = {
        blocks: nodeBlocks,
        route: routeOf(snap.state, session, agent),
        usage: undefined,
        source: 'self',
      }
      await engine.fold({
        agent,
        region: { startSeq: region.start, endSeq: region.end },
        blocks: prepared.blocks,
        route: prepared.route,
        usage: prepared.usage,
        signal,
      })
      return 'folded'
    } catch (error) {
      const kind = engine.classify(error)
      if (kind === 'busy') return 'busy'
      if (kind === 'summary') {
        skipTask(session, task.id, snap.epoch, 'the host refused the fold as not smaller than the span')
        return 'skipped'
      }
      retryLater(session, task.id, error, snap.epoch)
      return 'deferred'
    }
  }

  /**
   * @param {CompactionPort} engine
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
   * @param {number} epoch
   * @param {string} reason
   */
  function skipTask(session, taskId, epoch, reason) {
    const { changed } = apply(session, { type: 'skip', taskId, epoch, reason })
    if (changed)
      log('warn', `task-folding: folding ${taskId} is skipped at surface version ${epoch}: ${reason}`)
  }

  /**
   * A busy lock is not an error, but a task that waits silently for the whole process is
   * unobservable, so the first give-up is explained once per task. In memory only: a restart is a
   * new chance to explain it, and a permanently held lock logs exactly one line.
   *
   * @param {any} session
   * @param {string} taskId
   * @param {number} epoch
   */
  function waitOnce(session, taskId, epoch) {
    const { changed } = apply(session, { type: 'commit-busy', taskId, epoch })
    if (changed)
      log('warn', `task-folding: folding ${taskId} waits: the compaction lock is held by another compaction`)
  }

  /**
   * @param {any} session
   * @param {string} taskId
   * @param {unknown} error
   * @param {number} epoch
   */
  function retryLater(session, taskId, error, epoch) {
    const { runtime, changed } = apply(session, { type: 'retry', taskId, epoch })
    if (!changed) return
    const task = taskRuntime(runtime, taskId)
    if (task === undefined || task.retryAfter === null) return
    const message = error instanceof Error ? error.message : String(error)
    log(
      'warn',
      `task-folding: folding ${taskId} failed (attempt ${task.retries}), retrying in ${task.retryAfter - runtime.boundary} boundaries: ${message}`,
    )
  }

  // The delegate path is one concern: generation start/commit and the failure record live in their
  // own module, wired to the transitions and policies above.
  const generation = createGeneration({
    delegate: deps.delegate,
    estimator: deps.estimator,
    apply,
    runtimeOf,
    taskState,
    log,
    claimRejectLog,
    skipTask,
    noRegionOutcome,
    balanced,
    routeOf,
    retryLater,
  })

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
    /** Exposed for tests: the boundary counter of the most recent pass. */
    boundary: () => lastBoundary,
  }
}
