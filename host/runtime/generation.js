// Deferred summary generation (docs/10 §6): start at most one delegate generation per session,
// settle it in the background, and commit it at a later boundary only when the surface still
// describes the region it was written for. Every outcome is a named transition of the session
// runtime, so the scheduler cannot forget one, and every start is bound to the surface epoch it
// was resolved at (docs/10 §4.1) — the F9 race becomes a `deferred` transition instead of a
// permanent skip.
//
// Nothing here is awaited on the hot path: `start` is never awaited by the scheduler, and `step`
// only awaits a promise that already settled or settles now.
//
// This module keeps no state of its own beyond one cached "can this process summarize?" probe per
// runner instance. The per-session state is the scheduler's SessionRuntime.

import { resolveRegion } from '../domain/planner.js'
import { MAX_TASK_ATTEMPTS, isBackingOff, skipReason } from './session-runtime.js'

/** @typedef {import('../domain/types.js').State} State */
/** @typedef {import('../domain/types.js').Task} Task */
/** @typedef {import('../domain/planner.js').FoldRegion} FoldRegion */
/** @typedef {import('../domain/planner.js').Region} Region */
/** @typedef {import('../domain/surface.js').SurfaceSnapshot} Snapshot */
/** @typedef {import('../ports/compaction.js').CompactionPort} CompactionPort */
/** @typedef {import('../ports/compaction.js').FoldRoute} FoldRoute */
/** @typedef {import('../ports/compaction.js').SummaryResult} SummaryResult */
/** @typedef {import('./session-runtime.js').Action} Action */
/** @typedef {import('./session-runtime.js').SessionRuntime} SessionRuntime */
/** @typedef {import('./session-runtime.js').TaskRuntime} TaskRuntime */

/**
 * A fold region plus the key the scheduler computed for it before starting a delegate generation.
 *
 * @typedef {FoldRegion & { regionKey: string }} DelegateRegion
 */

/**
 * What a delegate generation summarizes: a closed task, or the turn itself on the implicit path.
 * The request is built from the region, so only `id` is informative to the seam.
 *
 * @typedef {{ id: string | null, title: string }} DelegateTarget
 */

/**
 * The delegate summarizer seam (ports/llm.js). It is injected so this module stays testable without
 * the real summarizer and so the plugin works when none can be built.
 *
 * @typedef {object} DelegateGeneration
 * @property {() => boolean} supports whether this process can build a summarizer
 * @property {(agent: any, target: DelegateTarget, region: DelegateRegion, signal: AbortSignal | undefined) => Promise<{ blocks: any[], regionKey: string, usage?: any } | null>} start
 *   starts the un-awaited generation; resolves the prepared blocks or null when no usable summary
 *   was produced
 */

/** A generated summary waiting for the next boundary to commit it. */
/** @typedef {{ blocks: any[], regionKey: string, usage?: any }} PendingSummary */

/**
 * What the generation needs from the scheduler: the runtime owner, the transitions and the
 * diagnostics. Every one is a scheduler function so this module never keeps a second copy of the
 * per-session state or of a skip/retry policy.
 *
 * @typedef {object} GenerationDeps
 * @property {DelegateGeneration} [delegate] the background summarizer; without it delegate tasks wait
 * @property {(session: any, action: Action) => { runtime: SessionRuntime, changed: boolean }} apply
 * @property {(session: any) => SessionRuntime} runtimeOf
 * @property {(session: any, taskId: string) => TaskRuntime | undefined} taskState
 * @property {(level: 'warn' | 'info' | 'error', message: string) => void} log
 * @property {(session: any, taskId: string) => boolean} claimRejectLog one-line explanation latch
 * @property {(session: any, taskId: string, epoch: number, reason: string) => void} skipTask
 * @property {(session: any, task: Task, region: Region, epoch: number) => 'skipped' | 'deferred'} noRegionOutcome
 * @property {(engine: CompactionPort, session: any, region: FoldRegion) => boolean} balanced
 * @property {(state: State, session: any, agent: any) => FoldRoute} routeOf
 * @property {(session: any, taskId: string, error: unknown, epoch: number) => void} retryLater
 */

/**
 * @param {GenerationDeps} deps
 */
export function createGeneration(deps) {
  /** @type {'unknown' | 'yes' | 'no'} */
  let delegateSupport = 'unknown'

  /** @param {any} session @param {string} taskId @returns {PendingSummary | undefined} */
  function pendingFor(session, taskId) {
    return deps.taskState(session, taskId)?.pending ?? undefined
  }

  /** @param {any} session @param {string} taskId @returns {boolean} */
  function backingOff(session, taskId) {
    return isBackingOff(deps.taskState(session, taskId), deps.runtimeOf(session).boundary)
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
   * Phase 1 of the two-phase delegate fold: start at most one background generation for a due
   * delegate task, before this pass commits any fold that would change the surface under it. The
   * promise is stored and never awaited here; starting costs O(1) (docs/03 §5.4).
   *
   * @param {any} agent
   * @param {any} session
   * @param {readonly Task[]} due
   * @param {Snapshot} snap
   * @param {CompactionPort} engine
   * @param {AbortSignal | undefined} signal
   */
  function start(agent, session, due, snap, engine, signal) {
    if (deps.runtimeOf(session).generation !== null || !delegateSupported()) return
    for (const dueTask of due) {
      const task = snap.state.tasks[dueTask.id]
      if (!task || task.status !== 'delegate') continue
      const runtime = deps.taskState(session, task.id)
      if ((runtime?.pending ?? null) !== null) continue
      // A failed generation is recorded durably before the task is retried, never instead of it.
      if (runtime?.failedGeneration === true) continue
      if (runtime !== undefined && runtime.attempts >= MAX_TASK_ATTEMPTS) continue
      if (skipReason(runtime, snap.epoch) !== undefined) continue
      if (backingOff(session, task.id)) continue
      // Never hand `start` a region the surface does not have: the generated text must describe
      // the span as it is now, and a task that can no longer fold must not be billed.
      const region = resolveRegion(task, snap.nodes)
      if (region.kind !== 'fold') continue
      if (!deps.balanced(engine, session, region)) continue
      startGeneration(agent, session, task, region, snap.epoch, signal)
      return
    }
  }

  /**
   * @param {any} agent
   * @param {any} session
   * @param {Task} task
   * @param {FoldRegion} region
   * @param {number} epoch
   * @param {AbortSignal | undefined} signal
   */
  function startGeneration(agent, session, task, region, epoch, signal) {
    const delegate = deps.delegate
    if (delegate === undefined) return
    const regionKey = regionKeyOf(region, session.surface.nodes)
    /** @type {DelegateRegion} */
    const request = { ...region, regionKey }
    // Promise.resolve() defers start() by one microtask so the in-flight entry below exists even
    // when the generator throws synchronously; the rejection handler keeps the promise from
    // surfacing as an unhandled rejection.
    Promise.resolve()
      .then(() => delegate.start(agent, task, request, signal))
      .then(
        (result) => {
          if (result === null) settleGeneration(session, task.id, 'failed')
          else settleGeneration(session, task.id, 'ok', result.blocks, result.usage)
        },
        (error) => {
          // A cancelled generation is not a failed attempt: the turn was interrupted, nothing was
          // generated, and counting it would push a task to `failed` for work that never ran. The
          // task simply waits for the next boundary.
          if (signal?.aborted === true) {
            deps.log('warn', `task-folding: the delegate summary for ${task.id} was cancelled with the turn`)
            settleGeneration(session, task.id, 'cancelled')
            return
          }
          const message = error instanceof Error ? error.message : String(error)
          deps.log('warn', `task-folding: no delegate summary for ${task.id}: ${message}`)
          settleGeneration(session, task.id, 'failed')
        },
      )
    deps.apply(session, { type: 'start-generation', taskId: task.id, epoch, regionKey })
  }

  /**
   * @param {any} session
   * @param {string} taskId
   * @param {'ok' | 'failed' | 'cancelled'} outcome
   * @param {any[]} [blocks]
   * @param {any} [usage]
   */
  function settleGeneration(session, taskId, outcome, blocks, usage) {
    deps.apply(session, {
      type: 'generation-finished',
      taskId,
      outcome,
      ...(blocks === undefined ? {} : { blocks }),
      ...(usage === undefined ? {} : { usage }),
    })
  }

  /**
   * Phase 2 for one delegate task: commit a generated summary when it still describes the region,
   * otherwise leave the task waiting for a later generation. Starting is phase 1's job, so this
   * never touches the surface between a start and its commit.
   *
   * @param {any} agent
   * @param {any} session
   * @param {Task} task
   * @param {Snapshot} snap
   * @param {CompactionPort} engine
   * @param {AbortSignal | undefined} signal
   * @returns {Promise<'folded' | 'busy' | 'skipped' | 'deferred'>}
   */
  async function stepDelegate(agent, session, task, snap, engine, signal) {
    const summary = pendingFor(session, task.id)
    if (summary !== undefined) return commitDelegate(agent, session, task, snap, engine, signal, summary)
    if (!delegateSupported()) return 'deferred'
    const region = resolveRegion(task, snap.nodes)
    if (region.kind !== 'fold') return deps.noRegionOutcome(session, task, region, snap.epoch)
    if (!deps.balanced(engine, session, region)) {
      deps.skipTask(session, task.id, snap.epoch, 'region is not tool-pairing balanced')
      return 'skipped'
    }
    return 'deferred'
  }

  /**
   * @param {any} agent
   * @param {any} session
   * @param {Task} task
   * @param {Snapshot} snap
   * @param {CompactionPort} engine
   * @param {AbortSignal | undefined} signal
   * @param {PendingSummary} summary
   * @returns {Promise<'folded' | 'busy' | 'skipped' | 'deferred'>}
   */
  async function commitDelegate(agent, session, task, snap, engine, signal, summary) {
    const region = resolveRegion(task, snap.nodes)
    if (region.kind !== 'fold') {
      // The span vanished or moved; the generated text can never describe it again.
      deps.apply(session, { type: 'drop-pending', taskId: task.id })
      return deps.noRegionOutcome(session, task, region, snap.epoch)
    }
    if (regionKeyOf(region, snap.nodes) !== summary.regionKey) {
      // The region changed while the summary was generated (another fold, the pruner, an auto
      // compaction): drop the text and generate again at a later boundary.
      deps.apply(session, { type: 'drop-pending', taskId: task.id })
      return 'deferred'
    }
    if (!deps.balanced(engine, session, region)) {
      deps.apply(session, { type: 'drop-pending', taskId: task.id })
      deps.skipTask(session, task.id, snap.epoch, 'region is not tool-pairing balanced')
      return 'skipped'
    }
    try {
      // The generated blocks are marked `delegate` in our own record of authorship: the host sees
      // prepared blocks unmarked, so `source` is the plugin's (docs/10 §8).
      /** @type {SummaryResult} */
      const prepared = {
        blocks: summary.blocks,
        route: deps.routeOf(snap.state, session, agent),
        usage: summary.usage,
        source: 'delegate',
      }
      await engine.fold({
        agent,
        region: { startSeq: region.start, endSeq: region.end },
        blocks: prepared.blocks,
        route: prepared.route,
        usage: prepared.usage,
        signal,
      })
      // The audit line docs/10 §8 asks for: the host records our summary unmarked, so this is the
      // only record of who wrote the blocks.
      deps.log('info', `task-folding: fold committed for ${task.id} source=${prepared.source}`)
      return 'folded'
    } catch (error) {
      const kind = engine.classify(error)
      if (kind === 'busy') return 'busy'
      if (kind === 'summary') {
        deps.apply(session, { type: 'drop-pending', taskId: task.id })
        deps.skipTask(session, task.id, snap.epoch, 'the host refused the fold as not smaller than the span')
        return 'skipped'
      }
      // Keep the text: an unexpected host failure is worth one more commit attempt, and
      // regenerating would bill the user again.
      deps.retryLater(session, task.id, error, snap.epoch)
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
   * @param {CompactionPort} engine
   * @param {AbortSignal | undefined} signal
   * @returns {Promise<boolean>} whether the host was asked to record the failure
   */
  async function recordFailure(agent, session, task, engine, signal) {
    const region = resolveRegion(task, session.surface.nodes)
    if (region.kind !== 'fold') return false
    try {
      await engine.reject({
        agent,
        region: { startSeq: region.start, endSeq: region.end },
        signal,
      })
    } catch (error) {
      // The host appends compaction/end{error} and then rethrows, so a rejection here is the
      // expected outcome; anything else cannot be retried without looping.
      if (deps.claimRejectLog(session, task.id)) {
        const message = error instanceof Error ? error.message : String(error)
        deps.log(
          'warn',
          `task-folding: could not record the failed delegate attempt for ${task.id}: ${message}`,
        )
      }
    }
    return true
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

  // -------------------------------------------------------------------------
  // The implicit turn fold (docs/03 §5.6, docs/07 Q10). It reuses the delegate seam, the region
  // key and the commit path of a delegate task; only its identity differs — the span, not a task.

  /**
   * Phase 1 of the implicit turn fold: start the one background generation a turn whose span clears
   * the floor gets. Returns whether a generation was started.
   *
   * @param {any} agent
   * @param {any} session
   * @param {{ startSeq: number, endSeq: number }} span the span the rule returned
   * @param {Snapshot} snap
   * @param {CompactionPort} engine
   * @param {AbortSignal | undefined} signal
   * @returns {boolean}
   */
  function startImplicit(agent, session, span, snap, engine, signal) {
    const delegate = deps.delegate
    if (delegate === undefined || !delegateSupported()) return false
    const runtime = deps.runtimeOf(session)
    const turn = snap.state.turnSeq
    if (turn === null) return false
    // One generation per session at a time, and at most one implicit fold per turn (docs/03 §5.6).
    if (runtime.implicit !== null || runtime.generation !== null) return false
    if (runtime.implicitTurn === turn) return false
    const startIndex = snap.nodes.indexOf(span.startSeq)
    const endIndex = snap.nodes.indexOf(span.endSeq)
    if (startIndex === -1 || endIndex === -1 || startIndex > endIndex) return false
    /** @type {FoldRegion} */
    const region = {
      kind: /** @type {const} */ ('fold'),
      start: span.startSeq,
      end: span.endSeq,
      startIndex,
      endIndex,
    }
    if (!deps.balanced(engine, session, region)) return false
    startImplicitGeneration(agent, session, region, snap.epoch, turn, runtime.boundary, signal)
    return true
  }

  /**
   * @param {any} agent
   * @param {any} session
   * @param {FoldRegion} region
   * @param {number} epoch
   * @param {number} turn
   * @param {number} id
   * @param {AbortSignal | undefined} signal
   */
  function startImplicitGeneration(agent, session, region, epoch, turn, id, signal) {
    const delegate = deps.delegate
    if (delegate === undefined) return
    const regionKey = regionKeyOf(region, session.surface.nodes)
    /** @type {DelegateRegion} */
    const request = { ...region, regionKey }
    /** @type {DelegateTarget} */
    const target = { id: null, title: '' }
    // Promise.resolve() defers the call by one microtask so the job exists before any settlement;
    // the rejection handler keeps a failed turn summary from surfacing as an unhandled rejection.
    Promise.resolve()
      .then(() => delegate.start(agent, target, request, signal))
      .then(
        (result) => {
          if (result === null) {
            // The summarizer answered, but with nothing usable. One line; the turn stays unfolded
            // and is not retried (docs/03 §5.6).
            deps.log('info', 'task-folding: no usable summary for the turn; it stays unfolded')
            settleImplicit(session, id, 'failed')
          } else settleImplicit(session, id, 'ok', result.blocks, result.usage)
        },
        (error) => {
          // An interrupted turn produced nothing; there is no durable record and no retry
          // (docs/03 §5.6), so the text is simply dropped.
          if (signal?.aborted === true) {
            deps.log('info', 'task-folding: the turn summary was cancelled with the turn')
            settleImplicit(session, id, 'cancelled')
            return
          }
          const message = error instanceof Error ? error.message : String(error)
          deps.log('info', `task-folding: no summary for the turn: ${message}`)
          settleImplicit(session, id, 'failed')
        },
      )
    deps.apply(session, {
      type: 'start-implicit',
      id,
      turn,
      epoch,
      start: region.start,
      end: region.end,
      startIndex: region.startIndex,
      endIndex: region.endIndex,
      regionKey,
    })
  }

  /**
   * @param {any} session
   * @param {number} id
   * @param {'ok' | 'failed' | 'cancelled'} outcome
   * @param {any[]} [blocks]
   * @param {any} [usage]
   */
  function settleImplicit(session, id, outcome, blocks, usage) {
    deps.apply(session, {
      type: 'implicit-finished',
      id,
      outcome,
      ...(blocks === undefined ? {} : { blocks }),
      ...(usage === undefined ? {} : { usage }),
    })
  }

  /**
   * Phase 2 of the implicit turn fold: commit a generated turn summary at a later boundary, when
   * the span it was written for still describes the surface. A commit that cannot happen drops the
   * text — the implicit fold has no durable failure accounting (docs/03 §5.6).
   *
   * @param {any} agent
   * @param {any} session
   * @param {Snapshot} snap
   * @param {CompactionPort} engine
   * @param {AbortSignal | undefined} signal
   * @returns {Promise<'folded' | 'busy' | 'dropped' | 'none'>}
   */
  async function commitImplicit(agent, session, snap, engine, signal) {
    const job = deps.runtimeOf(session).implicit
    if (job === null || job.phase !== 'ready') return 'none'
    const startIndex = snap.nodes.indexOf(job.start)
    const endIndex = snap.nodes.indexOf(job.end)
    if (startIndex === -1 || endIndex === -1 || startIndex > endIndex) {
      dropImplicit(session, job.id, 'its span is no longer on the surface')
      return 'dropped'
    }
    /** @type {FoldRegion} */
    const region = {
      kind: /** @type {const} */ ('fold'),
      start: job.start,
      end: job.end,
      startIndex,
      endIndex,
    }
    if (regionKeyOf(region, snap.nodes) !== job.regionKey) {
      dropImplicit(
        session,
        job.id,
        `the span changed while its summary was generated (surface ${job.epoch} -> ${snap.epoch})`,
      )
      return 'dropped'
    }
    if (!deps.balanced(engine, session, region)) {
      dropImplicit(session, job.id, 'the span is not tool-pairing balanced')
      return 'dropped'
    }
    try {
      await engine.fold({
        agent,
        region: { startSeq: region.start, endSeq: region.end },
        blocks: job.blocks ?? [],
        route: deps.routeOf(snap.state, session, agent),
        usage: job.usage,
        signal,
      })
      deps.apply(session, { type: 'implicit-committed', id: job.id })
      // The host records our summary unmarked, so this line is the only record of who wrote it.
      deps.log('info', 'task-folding: fold committed for the turn source=delegate')
      return 'folded'
    } catch (error) {
      // A busy lock is not an error: the job waits and the next boundary retries it.
      if (engine.classify(error) === 'busy') return 'busy'
      const message = error instanceof Error ? error.message : String(error)
      dropImplicit(session, job.id, message)
      return 'dropped'
    }
  }

  /**
   * @param {any} session
   * @param {number} id
   * @param {string} reason
   */
  function dropImplicit(session, id, reason) {
    deps.apply(session, { type: 'implicit-dropped', id })
    deps.log('info', `task-folding: the turn summary is dropped: ${reason}`)
  }

  return {
    start,
    stepDelegate,
    recordFailure,
    startImplicit,
    commitImplicit,
    delegateSupported,
    pendingFor,
  }
}
