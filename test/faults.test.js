// Fault injection at the runner seams (docs/09-testing-plan.md T3, docs/03 §5.4, §6, §11, §12):
// every seam — `stateOf`, `engine`, `delegate`, `logger`, the tool meter and the abort signal —
// is made to fail, and the runner must keep its promises: no throw out of `agent/pre-step` or
// `agent/turn-stopping`, no unhandled rejection, no double fold, no silently swallowed failure.
//
// The runner fakes are built here on purpose (T3 must keep asserting after the other helpers
// move): `runnerOf`, `successEngine`, `busyEngine`, `rejectEngine`, `delegateOf`'s failure
// shapes, `agentOf`, `flushMicrotasks` and the task builders are reduced copies from
// test/fold-runner.test.js. `Sim` and the tool harness are the shared fixtures the rest of the
// suite uses; they are not fakes of a seam.
//
// Nothing here sleeps: a boundary is driven to completion through the real `runner.pass` /
// `runner.preStep`, and background generations settle on microtasks the test flushes itself.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SpanEstimator } from '../host/estimate.js'
import { createFoldRunner } from '../host/fold-runner.js'
import { Sim } from './fixtures/sim.js'
import { at, fakeMeter, harnessOf, sessionOf } from './fixtures/tools.js'

/** A summary long enough to be usable (copied from test/fold-runner.test.js). */
const SUMMARY = `## Done\n${'Summarized the work with its changed paths and the reason for each choice. '.repeat(3)}`

/** The host decision `next()` produces; identity is what `agent/pre-step` must hand back. */
const DECISION = { kind: 'enter', messages: [] }

// ---------------------------------------------------------------------------
// Fakes

/**
 * One runner over a fake engine, logger and projection, in the shape of `runnerOf` in
 * test/fold-runner.test.js, with the two seams under fault injection (`stateOf`, `logger`)
 * overridable.
 *
 * @param {Sim} sim
 * @param {{
 *   engine?: any,
 *   stateOf?: (session: any) => Promise<any>,
 *   logger?: any,
 *   delegate?: any,
 *   estimator?: any,
 *   meter?: any,
 *   now?: () => number,
 * }} [options]
 */
function runnerOf(sim, options = {}) {
  /** @type {string[]} */
  const warnings = []
  const estimator = options.estimator ?? new SpanEstimator(options.meter ?? fakeMeter())
  const engine = options.engine ?? successEngine(sim)
  const runner = createFoldRunner({
    stateOf: options.stateOf ?? (async () => sim.state),
    engine: async () => engine,
    estimator,
    logger: options.logger ?? { warn: (/** @type {string} */ message) => warnings.push(message) },
    now: options.now ?? (() => 0),
    delegate: options.delegate,
  })
  return { runner, logs: warnings, engine, estimator }
}

/**
 * The host compaction transaction, happy path: record the request and apply the replacement.
 *
 * @param {Sim} sim
 */
function successEngine(sim) {
  /** @type {any[]} */
  const calls = []
  return {
    calls,
    /** @param {any} request */
    async fold(request) {
      const { agent, region, blocks, route, signal, usage } = request
      calls.push({ agent, start: region.startSeq, end: region.endSeq, blocks, route, signal, usage })
      sim.compact(region.startSeq, region.endSeq)
      return { start: region.startSeq, end: region.endSeq }
    },
    balancedBefore: () => true,
    balancedAfter: () => true,
    /** @param {any} _request */
    async reject(_request) {
      throw new Error('this test never records a failed delegate generation')
    },
    /** @returns {'other'} */
    classify: () => /** @type {'other'} */ ('other'),
  }
}

/**
 * Busy on the first `busyAttempts` fold calls, then the success engine: another transaction held
 * the durable lock and released it later (the shape of `busyOnceEngine` in
 * test/fold-runner.test.js, with a configurable count so one pass can see two busy answers).
 *
 * @param {Sim} sim
 * @param {number} busyAttempts
 */
function busyEngine(sim, busyAttempts) {
  const success = successEngine(sim)
  let busyLeft = busyAttempts
  /** @type {any[]} */
  const calls = success.calls
  return {
    calls,
    /** @param {any} request */
    async fold(request) {
      if (busyLeft > 0) {
        busyLeft -= 1
        calls.push({ busy: true })
        throw Object.assign(new Error('the compaction lock is held'), { code: 'busy' })
      }
      return success.fold(request)
    },
    balancedBefore: success.balancedBefore,
    balancedAfter: success.balancedAfter,
    /** @param {any} _request */
    async reject(_request) {
      throw new Error('this test never records a failed delegate generation')
    },
    /**
     * @param {unknown} error
     * @returns {'busy' | 'other'}
     */
    classify(error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      return code === 'busy' ? 'busy' : 'other'
    },
  }
}

/**
 * A success engine whose `reject` records the failure the way the host does: a zero-cost failed
 * compaction (`compaction/start` + `compaction/end{error}`) that is then rethrown (copied from
 * test/fold-runner.test.js).
 *
 * @param {Sim} sim
 */
function rejectEngine(sim) {
  const success = successEngine(sim)
  /** @type {{ start: number, end: number }[]} */
  const rejects = []
  return {
    calls: success.calls,
    fold: success.fold,
    balancedBefore: success.balancedBefore,
    balancedAfter: success.balancedAfter,
    classify: success.classify,
    rejects,
    /** @param {any} request */
    async reject(request) {
      const { startSeq: start, endSeq: end } = request.region
      rejects.push({ start, end })
      sim.failCompaction()
      throw new Error('the summary is unavailable')
    },
  }
}

/**
 * A delegate seam that always fails at generation start: synchronously, as a rejected promise, or
 * by resolving `null` (the three failure shapes T3 injects).
 *
 * @param {'sync' | 'reject' | 'null'} mode
 */
function failingDelegate(mode) {
  let starts = 0
  /** @type {any} */
  const delegate = {
    supports: () => true,
    start() {
      starts += 1
      if (mode === 'sync') throw new Error('the summarizer threw synchronously')
      if (mode === 'reject') return Promise.reject(new Error('the provider rejected the call'))
      return Promise.resolve(null)
    },
  }
  return { delegate, starts: () => starts }
}

/**
 * @typedef {object} ControlledGeneration
 * @property {any} region the request the runner handed over, including its `regionKey`
 * @property {AbortSignal | undefined} signal
 * @property {(result: any) => void} resolve
 * @property {(error: any) => void} reject
 */

/**
 * A delegate seam whose generations the test settles explicitly: an abort of the signal rejects
 * the generation, the way `generateDelegateSummary` fails on an aborted stream (host/summarizer.js
 * `throwOnFinish`). At most one generation is in flight per session, so the array is ordered.
 */
function controlledDelegate() {
  /** @type {ControlledGeneration[]} */
  const generations = []
  /** @type {any} */
  const delegate = {
    supports: () => true,
    /**
     * @param {any} _agent
     * @param {any} _task
     * @param {any} region
     * @param {AbortSignal | undefined} signal
     */
    start(_agent, _task, region, signal) {
      return new Promise((resolve, reject) => {
        generations.push({ region: { ...region }, signal, resolve, reject })
        signal?.addEventListener('abort', () => reject(new Error('the delegate call was aborted')), {
          once: true,
        })
      })
    },
  }
  return { delegate, generations }
}

/** @param {Sim} sim */
function agentOf(sim) {
  return { session: sessionOf(sim), options: { provider: 'opt-provider', model: 'opt-model' } }
}

/** Let every deferred handler the runner installed run; no timer is involved. */
async function flushMicrotasks() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
}

/**
 * Run `body` while counting `unhandledRejection` events. A background generation must never
 * surface as one: `startGeneration` attaches its handlers synchronously in the same microtask
 * chain, even when `delegate.start` throws synchronously (host/fold-runner.js:224-252).
 *
 * @param {() => Promise<void>} body
 * @returns {Promise<unknown[]>}
 */
async function unhandledRejectionsDuring(body) {
  /** @type {unknown[]} */
  const reasons = []
  /** @param {unknown} reason */
  const onUnhandled = (reason) => reasons.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    await body()
    await flushMicrotasks()
    // One check-phase tick: a rejection still unhandled when the microtask queue drains is
    // reported here. This is not a timer and does not make the test slow or flaky.
    await new Promise((resolve) => setImmediate(resolve))
    await flushMicrotasks()
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
  return reasons
}

/**
 * Drive one real `agent/pre-step` boundary. `next()` returns DECISION and the hook must hand that
 * same object back: `guarded` only catches around the pass, so any rejection would replace it
 * (host/fold-runner.js:682-707).
 *
 * @param {any} runner
 * @param {any} agent
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<void>}
 */
async function preStepBoundary(runner, agent, signal) {
  const returned = await runner.preStep({ agent, turn: 1, step: 1, signal }, async () => DECISION)
  assert.equal(returned, DECISION, 'the hook handed the host decision through')
}

/**
 * A session with one closed `queued` task (T1) that the model has already reported on, so
 * `agent/pre-step` considers it due (docs/03 §5.1).
 *
 * @returns {Promise<Sim>}
 */
async function reportedQueuedTask() {
  const sim = new Sim()
  const h = harnessOf(sim, { meter: fakeMeter() })
  await h.batch([{ name: 'task_begin', args: { title: 'foldable' } }])
  sim.work(4)
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])
  sim.say()
  assert.equal(sim.state.tasks.T1?.status, 'queued')
  assert.equal(sim.state.tasks.T1?.reported, true)
  return sim
}

/**
 * A session with one closed `delegate` task (T1): its own summary is too short (copied from
 * test/fold-runner.test.js).
 *
 * @returns {Promise<Sim>}
 */
async function delegateTask() {
  const sim = new Sim()
  const h = harnessOf(sim, { meter: fakeMeter() })
  await h.batch([{ name: 'task_begin', args: { title: 'delegated' } }])
  sim.work(4)
  await h.batch([{ name: 'task_end', args: { summary: 'Too short.' } }])
  assert.equal(sim.state.tasks.T1?.status, 'delegate')
  return sim
}

/**
 * A session with an inner `queued` task (T2) inside an outer `delegate` task (T1): folding T2
 * moves T1's cuts (copied from test/fold-runner.test.js).
 *
 * @returns {Promise<Sim>}
 */
async function nestedDelegateTask() {
  const sim = new Sim()
  const h = harnessOf(sim, { meter: fakeMeter() })
  await h.batch([{ name: 'task_begin', args: { title: 'outer' } }])
  await h.batch([{ name: 'task_begin', args: { title: 'inner' } }])
  sim.work(4)
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])
  sim.work(4)
  await h.batch([{ name: 'task_end', args: { summary: 'Too short.' } }])
  assert.equal(sim.state.tasks.T2?.status, 'queued')
  assert.equal(sim.state.tasks.T1?.status, 'delegate')
  return sim
}

/** @param {Sim} sim */
function compactionStarts(sim) {
  return sim.events.filter((event) => event.type === 'compaction/start').length
}

/**
 * @param {Sim} sim
 */
function compactionEnds(sim) {
  return sim.events.filter((event) => event.type === 'compaction/end').length
}

/**
 * @param {Sim} sim
 */
function surfaceReplacements(sim) {
  return sim.events.filter((event) => typeof event.surfaceOp === 'object').length
}

/**
 * The host's documented handling of a tool call (docs/02-host-api.md §4: a throwing `execute`
 * becomes `isError: true`, content `Error: <message>`, and no `meta`, `toolErrorResult` in
 * `pipeline.ts`). The two branches are the contract this test asserts the tool side of; no host
 * service is mocked.
 *
 * @param {any} definition
 * @param {any} args
 * @param {any} exec
 * @returns {Promise<{ isError: boolean, text: string, meta: unknown }>}
 */
async function toolOutcome(definition, args, exec) {
  try {
    const value = await definition.execute(args, exec)
    const meta = definition.output.presentationMeta?.(args, value)
    return { isError: false, text: '', meta }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { isError: true, text: `Error: ${message}`, meta: undefined }
  }
}

// ---------------------------------------------------------------------------
// 1. `stateOf` throws or rejects

test('a failing stateOf is logged once, folds nothing, and the next boundary folds normally', async () => {
  // docs/03 §11: the projection is the only state source, so a read failure is a failed pass, not
  // a crash of the step. `guarded` logs the message and `agent/pre-step` still returns next()'s
  // decision (host/fold-runner.js:682-695).
  const sim = await reportedQueuedTask()
  let reads = 0
  const { runner, logs, engine } = runnerOf(sim, {
    stateOf: async () => {
      reads += 1
      if (reads <= 2) throw new Error('projection unavailable')
      return sim.state
    },
  })
  const agent = agentOf(sim)

  // Throwing shape: boundary 1 through the real pre-step hook.
  await preStepBoundary(runner, agent, undefined)
  assert.equal(logs.length, 1, 'exactly one line for one failed pass')
  assert.match(at(logs, 0), /fold pass failed: projection unavailable/)
  assert.equal(engine.calls.length, 0, 'nothing is folded without state')

  // Throwing shape out of `agent/turn-stopping`: the second read fails too.
  await assert.doesNotReject(runner.turnStopping({ agent, turn: 1 }))
  assert.equal(logs.length, 2, 'one line per failed boundary')
  assert.equal(engine.calls.length, 0)

  // The next boundary is a normal boundary: the same task folds and no extra line appears.
  const report = await runner.pass(agent, undefined, true)
  assert.deepEqual(report, { folded: 1, busy: false, skipped: [] })
  assert.equal(sim.state.tasks.T1?.status, 'folded')
  assert.equal(logs.length, 2, 'a healthy boundary adds no line')

  // Rejecting-promise shape: same outcome.
  const rejecting = await reportedQueuedTask()
  const rejected = runnerOf(rejecting, {
    stateOf: () => Promise.reject(new Error('projection rejected')),
  })
  await preStepBoundary(rejected.runner, agentOf(rejecting), undefined)
  assert.equal(rejected.logs.length, 1)
  assert.match(at(rejected.logs, 0), /fold pass failed: projection rejected/)
  assert.equal(rejected.engine.calls.length, 0)
})

// ---------------------------------------------------------------------------
// 2. `engine.balancedBefore` / `balancedAfter` throws

test('a throwing tool-pairing check skips the task once and never folds it', async () => {
  // docs/03 §5.2: an unbalanced edge is a bug (cuts are balanced by construction). The runner
  // catches the check's throw, treats it as "not balanced", reports the invariant violation once
  // and leaves the task unfoldable for the process (host/fold-runner.js:562-568, 619-625). The
  // thrown message itself is not carried into that line; the skip reason is.
  for (const checked of ['balancedBefore', 'balancedAfter']) {
    const sim = await reportedQueuedTask()
    const engine = successEngine(sim)
    if (checked === 'balancedBefore') {
      engine.balancedBefore = () => {
        throw new Error('pairing check exploded')
      }
    } else {
      engine.balancedAfter = () => {
        throw new Error('pairing check exploded')
      }
    }
    const { runner, logs } = runnerOf(sim, { engine })
    const agent = agentOf(sim)

    const first = await runner.pass(agent, undefined, true)
    assert.deepEqual(first, { folded: 0, busy: false, skipped: ['T1'] })
    assert.equal(engine.calls.length, 0, 'the refused task never reaches foldRegion')
    assert.equal(sim.state.tasks.T1?.status, 'queued', 'the task waits, it is not folded')
    assert.equal(logs.length, 1, 'the violation is reported exactly once')
    assert.match(
      at(logs, 0),
      /folding T1 is skipped at surface version \d+: region is not tool-pairing balanced/,
    )

    // Skipped for the rest of the process: no second check, no second line.
    const second = await runner.pass(agent, undefined, true)
    assert.deepEqual(second, { folded: 0, busy: false, skipped: [] })
    assert.equal(logs.length, 1)
    assert.equal(engine.calls.length, 0)
  }
})

// ---------------------------------------------------------------------------
// 3. `engine.foldRegion` throws before writing anything

test('a fold that fails before writing stays waiting and is retried on the backoff schedule', async () => {
  // docs/03 §5.3 step 7: an unexpected failure is logged once per attempt and retried 1, 2, 4, 8
  // boundaries later (host/fold-runner.js:545-554, 665-676). The pass reports the failure through
  // that line and returns a normal report; `agent/pre-step` still hands the decision through.
  const sim = await reportedQueuedTask()
  const engine = successEngine(sim)
  let attempts = 0
  engine.fold = async () => {
    attempts += 1
    throw new Error('the transaction could not start')
  }
  const { runner, logs } = runnerOf(sim, { engine })
  const agent = agentOf(sim)

  await preStepBoundary(runner, agent, undefined) // boundary 1
  assert.equal(attempts, 1)
  assert.equal(logs.length, 1)
  assert.match(
    at(logs, 0),
    /folding T1 failed \(attempt 1\), retrying in 1 boundaries: the transaction could not start/,
  )
  assert.equal(sim.state.tasks.T1?.status, 'queued', 'the task stays waiting after the failure')

  const second = await runner.pass(agent, undefined, true) // boundary 2: retry after 1
  assert.deepEqual(second, { folded: 0, busy: false, skipped: [] }, 'the failure is a log, not a throw')
  assert.equal(attempts, 2)
  assert.match(at(logs, 1), /attempt 2\), retrying in 2 boundaries/)

  await runner.pass(agent, undefined, true) // boundary 3: backing off
  assert.equal(attempts, 2, 'still inside the two-boundary delay')

  await runner.pass(agent, undefined, true) // boundary 4: retry after 2 more
  assert.equal(attempts, 3)
  assert.match(at(logs, 2), /attempt 3\), retrying in 4 boundaries/)
  assert.equal(logs.length, 3, 'one line per attempt, none for the skipped boundaries')
  assert.equal(sim.state.tasks.T1?.status, 'queued')
})

// ---------------------------------------------------------------------------
// 4. `engine.foldRegion` writes the transaction and then throws

test('a fold that commits and then throws is counted once and never folded twice', async () => {
  // The host appends the whole transaction and the acknowledgement is lost: the runner cannot know
  // the fold is durable, so it backs off exactly once (host/fold-runner.js:545-554). The next
  // boundary re-reads the projection, sees the task terminal, and never opens a second transaction.
  const sim = await reportedQueuedTask()
  const engine = successEngine(sim)
  /** @type {{ start: number, end: number }[]} */
  const commits = []
  engine.fold = async (request) => {
    const { startSeq: start, endSeq: end } = request.region
    commits.push({ start, end })
    sim.compact(start, end) // the transaction commits its body...
    throw new Error('the commit acknowledgement was lost') // ...and the answer never arrives
  }
  const { runner, logs } = runnerOf(sim, { engine })
  const agent = agentOf(sim)

  const first = await runner.pass(agent, undefined, true)
  assert.deepEqual(first, { folded: 0, busy: false, skipped: [] }, 'the runner cannot count the fold')
  assert.equal(commits.length, 1)
  assert.equal(sim.state.tasks.T1?.status, 'folded', 'the committed fold is durable')
  assert.equal(sim.state.folds.length, 1)
  assert.equal(compactionStarts(sim), 1, 'one transaction, no duplicate compaction/start')
  assert.equal(compactionEnds(sim), 1)
  assert.equal(logs.length, 1, 'the failure is counted exactly once')
  assert.match(at(logs, 0), /folding T1 failed \(attempt 1\), retrying in 1 boundaries/)

  // The next boundary finds the task terminal: not folded again, not counted again.
  const second = await runner.pass(agent, undefined, true)
  assert.deepEqual(second, { folded: 0, busy: false, skipped: [] })
  assert.equal(commits.length, 1, 'no second transaction')
  assert.equal(compactionStarts(sim), 1, 'no second compaction/start')
  assert.equal(logs.length, 1, 'no second failure line')
})

// ---------------------------------------------------------------------------
// 5. `delegate.start` throws synchronously

test('a synchronous delegate throw becomes one failed generation, not an unhandled rejection', async () => {
  // host/fold-runner.js:224-252 defers `start` by one microtask and installs both handlers in the
  // same chain, so a synchronous throw is a rejected generation, logged once and recorded durably
  // at the next boundary (docs/03 §5.4).
  const sim = await delegateTask()
  const failing = failingDelegate('sync')
  const engine = rejectEngine(sim)
  const { runner, logs } = runnerOf(sim, { engine, delegate: failing.delegate })
  const agent = agentOf(sim)

  const reasons = await unhandledRejectionsDuring(async () => {
    await runner.pass(agent, undefined, true) // boundary 1 starts the generation
  })
  assert.deepEqual(reasons, [], 'a synchronous throw must not surface as an unhandled rejection')
  assert.equal(failing.starts(), 1)
  // The throw settles on a microtask, so the same pass may already see it (the snapshot is re-read
  // after phase 1). The invariant is one naming and one durable record per failed generation, not
  // which side of a boundary they land on.
  assert.equal(logs.filter((line) => /no delegate summary for T1/.test(line)).length, 1, 'named once')
  assert.match(at(logs, 0), /no delegate summary for T1: the summarizer threw synchronously/)
  assert.equal(engine.calls.length, 0, 'nothing reached foldRegion')
  assert.ok(engine.rejects.length <= 1)

  // Every failed generation becomes exactly one durable record and one named line; how many
  // boundaries that takes is an implementation detail (the pass may record in the same one).
  let boundaries = 1
  while (sim.state.tasks.T1?.status === 'delegate' && boundaries < 6) {
    await runner.pass(agent, undefined, true)
    boundaries += 1
    assert.equal(engine.rejects.length, sim.state.tasks.T1?.failures, 'one record per counted failure')
    assert.equal(engine.calls.length, 0, 'nothing reached foldRegion')
  }
  assert.equal(engine.rejects.length, 3, 'the cap is three')
  assert.equal(sim.state.tasks.T1?.status, 'failed')
  assert.equal(
    logs.filter((line) => /no delegate summary for T1/.test(line)).length,
    3,
    'each failed generation is named exactly once',
  )
})

// ---------------------------------------------------------------------------
// 6. `delegate.start` rejects, or resolves null, until the durable cap

test('a rejected or null generation records one durable failure each until the task is failed', async () => {
  // docs/03 §5.4 failure accounting: each failed generation becomes one zero-cost failed
  // compaction through `rejectRegion`; the projection counts it, and the third one makes the task
  // terminal `failed` (host/projection.js:193-203, MAX_DELEGATE_FAILURES = 3).
  for (const mode of ['reject', 'null']) {
    const sim = await delegateTask()
    const failing = failingDelegate(/** @type {'reject' | 'null'} */ (mode))
    const engine = rejectEngine(sim)
    const { runner, logs } = runnerOf(sim, { engine, delegate: failing.delegate })
    const agent = agentOf(sim)

    const reasons = await unhandledRejectionsDuring(async () => {
      // Boundary 1 starts generation 1; it fails and is remembered, not yet recorded.
      await runner.pass(agent, undefined, true)
      assert.equal(failing.starts(), 1)
      assert.equal(sim.state.tasks.T1?.failures, 0)
      assert.deepEqual(engine.rejects, [], 'nothing durable before the next boundary')

      // Boundary 2 records generation 1 as exactly one durable failed compaction.
      await runner.pass(agent, undefined, true)
      assert.equal(engine.rejects.length, 1, 'one durable record per failed generation')
      assert.equal(sim.state.tasks.T1?.failures, 1)
      assert.equal(sim.state.tasks.T1?.status, 'delegate')

      // Boundaries 3 and 4: generation 2 and its one record.
      await runner.pass(agent, undefined, true)
      assert.equal(failing.starts(), 2)
      await runner.pass(agent, undefined, true)
      assert.equal(engine.rejects.length, 2)
      assert.equal(sim.state.tasks.T1?.failures, 2)

      // Boundaries 5 and 6: generation 3 and the record that reaches the cap.
      await runner.pass(agent, undefined, true)
      assert.equal(failing.starts(), 3)
      await runner.pass(agent, undefined, true)
      assert.equal(engine.rejects.length, 3)
      assert.equal(sim.state.tasks.T1?.failures, 3)
      assert.equal(sim.state.tasks.T1?.status, 'failed')

      // A terminal task is never retried: no generation, no record, no fold.
      await runner.pass(agent, undefined, true)
      assert.equal(failing.starts(), 3)
      assert.equal(engine.rejects.length, 3)
    })
    assert.deepEqual(reasons, [], 'a rejected generation promise is handled by the runner')
    assert.equal(engine.calls.length, 0, 'a failed generation never reaches foldRegion')
    assert.equal(
      sim.events.filter((event) => event.type === 'compaction/end' && event.data?.error !== undefined).length,
      3,
      'exactly three durable failure rows for three failed generations',
    )
    assert.equal(
      logs.filter((line) => line.includes('no delegate summary')).length,
      mode === 'reject' ? 3 : 0,
      'a rejection is logged; a null generation is silent',
    )
    assert.equal(
      logs.filter((line) => line.includes('could not record the failed delegate attempt')).length,
      1,
      'the record failure is logged once per task, never in a loop',
    )
  }
})

// ---------------------------------------------------------------------------
// 7. Abort mid-generation

test('an aborted generation is cancelled, not counted as a failed attempt', async () => {
  // A turn that is interrupted did not produce a bad summary — it produced nothing. Counting it
  // would push a task to `failed` for work that never ran, so the runner logs the cancellation,
  // forgets the generation and leaves the task waiting (host/fold-runner.js, the abort branch of
  // startGeneration's rejection handler).
  const sim = await delegateTask()
  const controlled = controlledDelegate()
  const engine = rejectEngine(sim)
  const { runner, logs } = runnerOf(sim, { engine, delegate: controlled.delegate })
  const agent = agentOf(sim)

  const reasons = await unhandledRejectionsDuring(async () => {
    const controller = new AbortController()
    await runner.pass(agent, controller.signal, true) // boundary 1 starts the generation
    assert.equal(controlled.generations.length, 1)
    controller.abort()
    await flushMicrotasks()
    assert.equal(logs.length, 1, 'the cancellation is logged once')
    assert.match(at(logs, 0), /was cancelled with the turn/)
    // Nothing to commit and nothing to record.
    await runner.pass(agent, undefined, true) // boundary 2
  })
  assert.deepEqual(reasons, [])
  assert.equal(engine.calls.length, 0, 'nothing reached foldRegion')
  assert.equal(engine.rejects.length, 0, 'no durable failure was written for a cancellation')
  assert.equal(sim.state.tasks.T1?.failures, 0, 'the durable cap did not move')
  assert.equal(sim.state.tasks.T1?.status, 'delegate', 'the task still waits for a later summary')
})
test('an abort before the fold transaction folds nothing and does not escape the hook', async () => {
  // The runner does not own the abort check on the fold path: it hands the signal to
  // `engine.foldRegion` (host/fold-runner.js:536-543), and the host's transaction refuses at
  // `summarize()` with the aborted signal (docs/02 §6 transaction order: any failure before the
  // body commit appends `compaction/end{error}` and rethrows). The runner classifies the error as
  // unexpected, logs one line and backs off: no replacement, no partial checkpoint.
  const sim = await reportedQueuedTask()
  const controller = new AbortController()
  let aborted = false
  /** @type {boolean[]} */
  const signalStates = []
  const engine = successEngine(sim)
  engine.fold = async (request) => {
    const { signal } = request
    signalStates.push(signal !== undefined && signal.aborted)
    // The host appends compaction/start, then refuses the abort at summarize() and closes the
    // transaction with compaction/end{error}.
    sim.failCompaction()
    throw new Error('The operation was aborted')
  }
  const { runner, logs } = runnerOf(sim, {
    engine,
    stateOf: async () => {
      // The pass is aborted after it read the state and before the fold transaction.
      if (!aborted) {
        aborted = true
        controller.abort()
      }
      return sim.state
    },
  })

  const returned = await runner.preStep(
    { agent: agentOf(sim), turn: 1, step: 1, signal: controller.signal },
    async () => DECISION,
  )
  assert.equal(returned, DECISION, 'the aborted pass never escapes agent/pre-step')
  assert.deepEqual(signalStates, [true], 'the aborted signal reaches the engine, which owns refusal')
  assert.equal(sim.state.tasks.T1?.status, 'queued', 'no fold is recorded')
  assert.equal(sim.state.folds.length, 0)
  assert.equal(
    sim.events.filter((event) => event.type === 'compaction/summary').length,
    0,
    'no summary body was written',
  )
  assert.equal(surfaceReplacements(sim), 0, 'no replacement: no partial write')
  assert.equal(logs.length, 1)
  assert.match(
    at(logs, 0),
    /folding T1 failed \(attempt 1\), retrying in 1 boundaries: The operation was aborted/,
  )
})

// ---------------------------------------------------------------------------
// 9. The compaction lock is held

test('a held lock retries once in the pass, logs once, and folds at the next boundary', async () => {
  // docs/03 §5.5: a busy answer is not an error. The runner retries the same task once in the same
  // pass; a second busy answer stops the pass, leaves the task queued and explains it once per
  // task for the process (host/fold-runner.js:132-149, 644-652).
  const sim = await reportedQueuedTask()
  const engine = busyEngine(sim, 2) // busy on the attempt and on the in-pass retry
  const { runner, logs } = runnerOf(sim, { engine })
  const agent = agentOf(sim)

  const first = await runner.pass(agent, undefined, true)
  assert.deepEqual(first, { folded: 0, busy: true, skipped: [] })
  assert.equal(engine.calls.length, 2, 'one attempt and one retry, never a loop')
  assert.equal(sim.state.tasks.T1?.status, 'queued')
  assert.equal(logs.length, 1)
  assert.match(at(logs, 0), /folding T1 waits: the compaction lock is held by another compaction/)

  // The next boundary folds normally, through the real hook, with no second line.
  await preStepBoundary(runner, agent, undefined)
  assert.equal(sim.state.tasks.T1?.status, 'folded')
  assert.equal(engine.calls.length, 3)
  assert.equal(logs.length, 1)
})

// ---------------------------------------------------------------------------
// 10. `logger.warn` / `logger.error` throws

// A logger is diagnostics: a sink that throws must not replace the error being reported and must not
// escape the hook. Every runner log goes through a non-throwing helper.
// promises below:
//  - `retryLater` (host/fold-runner.js:673-675) is called from inside `foldOne`'s catch
//    (host/fold-runner.js:545-554), so its throw replaces the original fold error, propagates out
//    of the pass and is then re-thrown by `guarded`'s own `logger.warn` (host/fold-runner.js:687-690):
//    `agent/pre-step` and `agent/turn-stopping` reject with the logger's message.
//  - `skipOnce` (host/fold-runner.js:624) and `waitOnce` (host/fold-runner.js:649) throw out of the
//    pass the same way.
//  - `startGeneration`'s rejection handler (host/fold-runner.js:242-247) throws inside a promise
//    handler whose result nobody holds, so one `unhandledRejection` fires per failed generation.
// `logger.error` is never called by the runner (`host/fold-runner.js:48` declares only warn/info).
test('a throwing logger neither breaks the pass nor replaces the original error', async () => {
  const sim = await reportedQueuedTask()
  const engine = successEngine(sim)
  engine.fold = async () => {
    throw new Error('the transaction could not start')
  }
  /** @type {string[]} */
  const attempts = []
  const runner = createFoldRunner({
    stateOf: async () => sim.state,
    engine: async () => engine,
    estimator: new SpanEstimator(fakeMeter()),
    logger: {
      /** @param {string} message */
      warn(message) {
        attempts.push(message)
        throw new Error('the logger is down')
      },
    },
    now: () => 0,
  })

  const returned = await runner.preStep({ agent: agentOf(sim), turn: 1, step: 1 }, async () => DECISION)
  assert.equal(returned, DECISION, 'the hook is not broken by the logger')
  assert.equal(attempts.length, 1, 'the original failure is reported exactly once')
  assert.match(
    at(attempts, 0),
    /folding T1 failed \(attempt 1\).*the transaction could not start/,
    'the line carries the original error, not the logger error',
  )
  // The overridden foldRegion throws before the fake records a call, so the observable proof that
  // the pass completed is the returned decision plus the recorded backoff, not engine.calls.
  assert.equal(sim.state.tasks.T1?.status, 'queued')
  assert.equal(sim.state.tasks.T1?.failures, 0, 'a retryable failure is not a task_end failure')
})

// ---------------------------------------------------------------------------
// 11. `tokenMeter.estimateMessage` throws

test('a throwing token meter is reported as a tool error, not a crashed step', async () => {
  // `estimate.js` normalises a non-numeric estimate but does not catch a throwing meter, so
  // `task_end` throws. That is the documented tool-error path: the host turns a throwing tool into
  // `isError: true`, content `Error: <message>`, no `meta` (docs/02 §4), so the step keeps
  // running and the task is not corrupted with a partial result.
  const sim = new Sim()
  const meter = {
    estimateMessage() {
      throw new Error('the token meter is down')
    },
  }
  const h = harnessOf(sim, { meter })
  await h.batch([{ name: 'task_begin', args: { title: 'no meter' } }])
  sim.work(4)

  const exec = {
    callId: 'call_meter',
    rootCallId: 'call_meter',
    agent: { session: h.session },
    arguments: { summary: SUMMARY },
  }
  const outcome = await toolOutcome(h.byName.task_end, { summary: SUMMARY }, exec)
  assert.equal(outcome.isError, true, 'the failure is data for the model, not a crash')
  assert.match(outcome.text, /^Error: the token meter is down$/)
  assert.equal(outcome.meta, undefined, 'no meta is written, so no partial task state lands')
  assert.equal(sim.state.tasks.T1?.status, 'open', 'the task stays open, not half-closed')

  // The step survives: with a working meter the same session still closes the task normally.
  const healthy = harnessOf(sim, { meter: fakeMeter() })
  const closed = await healthy.one({ name: 'task_end', args: { summary: SUMMARY } })
  assert.equal(closed.meta?.op, 'end')
  assert.equal(sim.state.tasks.T1?.status, 'queued')
})

// ---------------------------------------------------------------------------
// 12. The region moves while the generation is in flight, and the signal aborts

test('an aborted generation whose region moved is dropped and regenerated for the new span', async () => {
  // Phase 1 starts the generation against the span as it is; phase 2 then folds the inner task,
  // which moves the outer task's cuts (host/fold-runner.js:100-154). Aborting the in-flight
  // generation at that moment must commit nothing: the stale region key can never match again
  // (host/fold-runner.js:395-403), the task waits, and a later boundary generates and commits text
  // for the moved span (host/fold-runner.js:290-333).
  const sim = await nestedDelegateTask()
  const controlled = controlledDelegate()
  const engine = rejectEngine(sim)
  const { runner, logs } = runnerOf(sim, { engine, delegate: controlled.delegate })
  const agent = agentOf(sim)
  const stale = [{ type: 'text', text: '## Stale\nDescribes the span from before the move.' }]

  const reasons = await unhandledRejectionsDuring(async () => {
    const first = new AbortController()
    // Boundary 1: phase 1 starts T1's generation, phase 2 folds the inner T2 and moves T1's cuts.
    const report = await runner.pass(agent, first.signal, true)
    assert.deepEqual(report, { folded: 1, busy: false, skipped: [] })
    assert.equal(sim.state.tasks.T2?.status, 'folded')
    assert.equal(controlled.generations.length, 1)
    const staleRegion = at(controlled.generations, 0).region

    // Abort the generation while its region is already stale; a late resolve must change nothing.
    first.abort()
    await flushMicrotasks()
    at(controlled.generations, 0).resolve({ blocks: stale }) // already rejected: ignored
    assert.equal(logs.length, 1)
    assert.match(at(logs, 0), /was cancelled with the turn/)
    assert.equal(engine.calls.length, 1, 'only the inner self fold committed')
    assert.equal(sim.state.tasks.T1?.status, 'delegate')

    // The cancellation is not a failure; the stale text still never reaches foldRegion.
    await runner.pass(agent, undefined, true) // boundary 2
    assert.equal(engine.rejects.length, 0, 'a cancellation writes no durable failure')
    assert.equal(sim.state.tasks.T1?.failures, 0)
    assert.equal(engine.calls.length, 1)

    // Boundary 3 regenerates for the moved span: a different key, a new generation.
    await runner.pass(agent, undefined, true)
    assert.equal(controlled.generations.length, 2)
    const freshRegion = at(controlled.generations, 1).region
    assert.notEqual(freshRegion.regionKey, staleRegion.regionKey, 'the moved span has a new key')

    // Boundary 4 commits the text generated for the moved span.
    const fresh = [{ type: 'text', text: '## Fresh\nWritten for the moved span.' }]
    at(controlled.generations, 1).resolve({ blocks: fresh })
    await flushMicrotasks()
    const last = await runner.pass(agent, undefined, true)
    assert.deepEqual(last, { folded: 1, busy: false, skipped: [] })
    assert.equal(engine.calls.length, 2)
    assert.deepEqual(at(engine.calls, 1).blocks, fresh, 'the fresh text is committed')
    assert.equal(sim.state.tasks.T1?.status, 'folded')
    for (const call of engine.calls) assert.notDeepEqual(call.blocks, stale, 'stale text never commits')
  })
  assert.deepEqual(reasons, [])
  assert.equal(
    logs.filter((line) => line.includes('could not record the failed delegate attempt')).length,
    0,
    'a cancellation leaves nothing to record',
  )
})
