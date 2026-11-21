// The fold runner (docs/03 §5.1–5.3): which task folds when, in which order, and what happens
// when the host refuses. A fake engine stands in for the compaction transaction.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SpanEstimator } from '../host/domain/estimate.js'
import { createFoldRunner } from '../host/runtime/scheduler.js'
import { resolveRegion } from '../host/domain/planner.js'
import { Sim } from './fixtures/sim.js'
import { fakeMeter, at, harnessOf, sessionOf } from './fixtures/tools.js'

/** A summary long enough to be usable. */
const SUMMARY = `## Done\n${'Summarized the work with its changed paths and the reason for each choice. '.repeat(3)}`

/**
 * @param {Sim} sim
 * @param {{ meter?: any, engine?: any, now?: () => number, estimator?: any, delegate?: any }} [options]
 */
function runnerOf(sim, options = {}) {
  /** @type {string[]} */
  const logs = []
  const estimator = options.estimator ?? new SpanEstimator(options.meter ?? fakeMeter())
  const engine = options.engine ?? successEngine(sim)
  const runner = createFoldRunner({
    stateOf: async () => sim.state,
    engine: async () => engine,
    estimator,
    logger: { warn: (/** @type {string} */ message) => logs.push(message) },
    now: options.now ?? (() => 0),
    delegate: options.delegate,
  })
  return { runner, logs, engine, estimator }
}

/** @param {Sim} sim */
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
    /** @returns {'busy' | 'summary' | 'other'} */
    classify: () => 'other',
  }
}

/** @param {Sim} sim @param {Error} error @param {'busy' | 'summary' | 'other'} kind */
function failingEngine(sim, error, kind) {
  const engine = successEngine(sim)
  engine.fold = async () => {
    engine.calls.push({ error })
    throw error
  }
  engine.classify = () => kind
  return engine
}

/**
 * Busy on the first attempt only, then the success engine: another transaction held the lock and
 * released it before the retry.
 *
 * @param {Sim} sim
 */
function busyOnceEngine(sim) {
  const success = successEngine(sim)
  let busy = true
  return {
    calls: success.calls,
    /** @param {any} request */
    async fold(request) {
      if (busy) {
        busy = false
        success.calls.push({ busy: true })
        throw new Error('busy')
      }
      return success.fold(request)
    },
    balancedBefore: success.balancedBefore,
    balancedAfter: success.balancedAfter,
    /** @param {any} _request */
    async reject(_request) {
      throw new Error('this test never records a failed delegate generation')
    },
    /** @param {unknown} error @returns {'busy' | 'other'} */
    classify: (error) => (error instanceof Error && error.message === 'busy' ? 'busy' : 'other'),
  }
}

/** @param {Sim} sim */
function agentOf(sim) {
  return { session: sessionOf(sim), options: { provider: 'opt-provider', model: 'opt-model' } }
}

/** @param {Sim} sim */
function routedAgent(sim) {
  sim.push({
    type: 'request/header',
    data: { header: { config: { provider: 'header-provider', model: 'header-model' } }, reason: 'initial' },
  })
  return agentOf(sim)
}

/**
 * A delegate seam whose generations the test settles explicitly, so phase 1 can be observed while
 * the generation is still pending and without any timer.
 *
 * @param {{ supports?: () => boolean }} [options]
 */
function delegateOf(options = {}) {
  /** @type {{ agent: any, task: any, region: any, signal: AbortSignal | undefined, nodes: readonly number[] }[]} */
  const starts = []
  /** @type {((result: { blocks: any[], regionKey?: string, usage?: any } | null) => void)[]} */
  const settle = []
  let supportCalls = 0
  const delegate = {
    supports() {
      supportCalls += 1
      return options.supports === undefined ? true : options.supports()
    },
    /**
     * @param {any} agent
     * @param {any} task
     * @param {any} region
     * @param {AbortSignal | undefined} signal
     */
    start(agent, task, region, signal) {
      starts.push({ agent, task, region, signal, nodes: agent.session.surface.nodes.slice() })
      return new Promise((resolve) => settle.push(resolve))
    },
  }
  return {
    delegate,
    starts,
    supportCalls: () => supportCalls,
    /**
     * @param {number} index
     * @param {{ blocks: any[], regionKey?: string, usage?: any } | null} result
     */
    resolve(index, result) {
      const resolveGeneration = settle[index]
      if (resolveGeneration === undefined) throw new Error(`no pending generation at ${index}`)
      resolveGeneration(result)
    },
  }
}

/** Let the runner's deferred microtasks run; no timer is involved. */
async function flushMicrotasks() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

/**
 * Await a promise under a bounded number of microtasks, so a pass that wrongly waits for a pending
 * generation fails the test instead of hanging the run.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {string} message
 * @returns {Promise<T>}
 */
async function awaitWithinMicrotasks(promise, message) {
  /** @type {T | undefined} */
  let value
  let settled = false
  let rejected = false
  promise.then(
    (result) => {
      settled = true
      value = result
    },
    () => {
      settled = true
      rejected = true
    },
  )
  for (let i = 0; i < 100 && !settled; i += 1) await Promise.resolve()
  if (!settled) assert.fail(message)
  if (rejected) assert.fail(`${message}; the pass rejected instead of resolving`)
  return /** @type {T} */ (value)
}

/**
 * A session with one closed `delegate` task (T1): its own summary is too short.
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
 * A session with two closed `delegate` tasks (T1, T2): both summaries are too short.
 *
 * @returns {Promise<Sim>}
 */
async function twoDelegateTasks() {
  const sim = new Sim()
  const h = harnessOf(sim, { meter: fakeMeter() })
  await h.batch([{ name: 'task_begin', args: { title: 'first' } }])
  sim.work(4)
  await h.batch([{ name: 'task_end', args: { summary: 'Too short.' } }])
  await h.batch([{ name: 'task_begin', args: { title: 'second' } }])
  sim.work(4)
  await h.batch([{ name: 'task_end', args: { summary: 'Too short.' } }])
  assert.equal(sim.state.tasks.T1?.status, 'delegate')
  assert.equal(sim.state.tasks.T2?.status, 'delegate')
  return sim
}

/**
 * A session with an inner `queued` task (T2) and an outer `delegate` task (T1) whose summary is
 * too short; the outer span contains the inner span.
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

/**
 * A success engine whose `reject` records the failure the way the host does: a zero-cost failed
 * compaction that is then rethrown.
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
 * The region fields the runner hands over, without the key it owns.
 *
 * @param {{ start: number, end: number, startIndex: number, endIndex: number }} region
 */
function boundsOf(region) {
  return { start: region.start, end: region.end, startIndex: region.startIndex, endIndex: region.endIndex }
}

test('due tasks fold inner-first, and the outer span survives the inner fold', async () => {
  const sim = new Sim()
  const h = harnessOf(sim, { meter: fakeMeter() })
  await h.batch([{ name: 'task_begin', args: { title: 'outer' } }])
  await h.batch([{ name: 'task_begin', args: { title: 'inner' } }])
  sim.work(4)
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])
  assert.equal(sim.state.tasks.T2?.status, 'queued')
  assert.equal(sim.state.tasks.T1?.status, 'queued')

  const { runner, engine, logs } = runnerOf(sim)
  const report = await runner.pass(agentOf(sim), undefined, true)
  assert.equal(report.folded, 2)
  assert.equal(engine.calls.length, 2)
  const [first, second] = engine.calls
  assert.ok(first.start > second.start, 'the inner task folds first: its span starts later')
  assert.ok(first.end < second.end, 'the inner span ends before the outer one')
  assert.equal(sim.state.tasks.T2?.status, 'folded')
  assert.equal(sim.state.tasks.T1?.status, 'folded')
  assert.equal(sim.state.folds.length, 2)
  assert.deepEqual(logs, [])
})

test('a relay in one message yields two adjacent, separately folded regions', async () => {
  const sim = new Sim()
  const h = harnessOf(sim, { meter: fakeMeter() })
  await h.batch([{ name: 'task_begin', args: { title: 'outer' } }])
  await h.batch([{ name: 'task_begin', args: { title: 'inner' } }])
  sim.work(3)
  await h.batch([
    { name: 'task_end', args: { summary: SUMMARY } },
    { name: 'task_begin', args: { title: 'sibling' } },
  ])
  sim.work(3)
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])
  const relay = sim.state.tasks.T2?.endCut === sim.state.tasks.T3?.beginCut
  assert.ok(relay, 'the relay cuts are adjacent')

  const { runner, engine } = runnerOf(sim)
  const report = await runner.pass(agentOf(sim), undefined, true)
  assert.equal(report.folded, 3)
  assert.equal(engine.calls.length, 3)
  for (const id of ['T1', 'T2', 'T3']) assert.equal(sim.state.tasks[id]?.status, 'folded')
  assert.equal(sim.state.folds.length, 3)
})

test('the folded node text carries the title, the summary and the footer', async () => {
  const sim = new Sim()
  const h = harnessOf(sim, { meter: fakeMeter() })
  await h.batch([{ name: 'task_begin', args: { title: 'Fix login redirect loop' } }])
  sim.work(4)
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY, outcome: 'failed' } }])
  const { runner, engine } = runnerOf(sim)
  await runner.pass(agentOf(sim), undefined, true)
  const text = engine.calls[0].blocks[0].text
  assert.match(text, /^# T1 · Fix login redirect loop\n/)
  assert.ok(text.includes('Summarized the work'), 'the model summary is inside')
  assert.match(
    text,
    /— fold of T1 · \d+ messages · ~[\d.]+k? tokens · outcome: failed · originals: fold_recall\(\{ task: "T1" \}\)/,
  )
})

test('the route comes from the latest request header, then from the agent options', async () => {
  const sim = new Sim()
  const h = harnessOf(sim, { meter: fakeMeter() })
  await h.batch([{ name: 'task_begin', args: { title: 'routed' } }])
  sim.work(4)
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])
  const agent = routedAgent(sim)
  const { runner, engine } = runnerOf(sim)
  await runner.pass(agent, undefined, true)
  assert.deepEqual(engine.calls[0].route, { provider: 'header-provider', model: 'header-model' })
})

test('a busy lock is retried once and folds in the same pass', async () => {
  const sim = new Sim()
  const h = harnessOf(sim, { meter: fakeMeter() })
  await h.batch([{ name: 'task_begin', args: { title: 'busy' } }])
  sim.work(4)
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])

  const engine = busyOnceEngine(sim)
  const { runner, logs } = runnerOf(sim, { engine })
  const report = await runner.pass(agentOf(sim), undefined, true)
  assert.deepEqual(report, { folded: 1, busy: false, skipped: [] })
  assert.equal(engine.calls.length, 2, 'the busy attempt and the retry')
  assert.equal(sim.state.tasks.T1?.status, 'folded')
  assert.deepEqual(logs, [], 'a lock that is released before the retry is silent')
})

test('a permanently busy lock stops the pass and leaves the task queued', async () => {
  const sim = new Sim()
  const h = harnessOf(sim, { meter: fakeMeter() })
  await h.batch([{ name: 'task_begin', args: { title: 'busy' } }])
  sim.work(4)
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])

  const engine = failingEngine(sim, new Error('busy'), 'busy')
  const { runner, logs } = runnerOf(sim, { engine })
  const report = await runner.pass(agentOf(sim), undefined, true)
  assert.deepEqual(report, { folded: 0, busy: true, skipped: [] })
  assert.equal(engine.calls.length, 2, 'one attempt and one retry, never a loop')
  assert.equal(sim.state.tasks.T1?.status, 'queued')
  assert.equal(logs.length, 1)
  assert.match(logs[0] ?? '', /folding T1 waits: the compaction lock is held by another compaction/)
})

test('a busy lock is explained once per task for the process', async () => {
  const sim = new Sim()
  const h = harnessOf(sim, { meter: fakeMeter() })
  await h.batch([{ name: 'task_begin', args: { title: 'busy forever' } }])
  sim.work(4)
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])

  const engine = failingEngine(sim, new Error('busy'), 'busy')
  const { runner, logs } = runnerOf(sim, { engine })
  const agent = agentOf(sim)
  await runner.pass(agent, undefined, true)
  await runner.pass(agent, undefined, true)
  assert.equal(engine.calls.length, 4, 'each pass tries twice')
  const waitLines = logs.filter((line) => line.includes('waits: the compaction lock is held'))
  assert.equal(waitLines.length, 1, 'one line for the whole process, not one per pass')
  assert.match(waitLines[0] ?? '', /folding T1 waits/)
})

test('a busy lock another compaction wins neither stops the pass nor logs', async () => {
  const sim = new Sim()
  const h = harnessOf(sim, { meter: fakeMeter() })
  await h.batch([{ name: 'task_begin', args: { title: 'lost the race' } }])
  sim.work(4)
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])

  const engine = failingEngine(sim, new Error('busy'), 'busy')
  engine.fold = async () => {
    engine.calls.push({ busy: true })
    // The competing transaction commits the whole span before the retry gets its turn.
    sim.fold('T1')
    throw new Error('busy')
  }
  const { runner, logs } = runnerOf(sim, { engine })
  const report = await runner.pass(agentOf(sim), undefined, true)
  assert.deepEqual(report, { folded: 0, busy: false, skipped: [] })
  assert.equal(engine.calls.length, 1, 'the retry sees the task is no longer queued')
  assert.equal(sim.state.tasks.T1?.status, 'folded')
  assert.deepEqual(logs, [], 'the other transaction absorbed the work; nothing waits')
})

test('a summary the host refuses as not smaller demotes the task for the process', async () => {
  const sim = new Sim()
  const h = harnessOf(sim, { meter: fakeMeter() })
  await h.batch([{ name: 'task_begin', args: { title: 'too big' } }])
  sim.work(4)
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])
  const engine = failingEngine(sim, new Error('summary is not smaller than the shadowed content'), 'summary')
  const { runner, logs } = runnerOf(sim, { engine })
  const agent = agentOf(sim)
  assert.equal((await runner.pass(agent, undefined, true)).skipped[0], 'T1')
  assert.equal(sim.state.tasks.T1?.status, 'queued')
  assert.match(logs[0] ?? '', /T1.*not smaller/)
  await runner.pass(agent, undefined, true)
  assert.equal(engine.calls.length, 1, 'a demoted task is not retried in this process')
})

test('an unexpected failure backs off 1, 2, 4, 8 boundaries', async () => {
  const sim = new Sim()
  const h = harnessOf(sim, { meter: fakeMeter() })
  await h.batch([{ name: 'task_begin', args: { title: 'flaky' } }])
  sim.work(4)
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])
  const engine = failingEngine(sim, new Error('boom'), 'other')
  const { runner, logs } = runnerOf(sim, { engine })
  const agent = agentOf(sim)

  await runner.pass(agent, undefined, true) // boundary 1, failures 1 → retry in 1
  assert.equal(engine.calls.length, 1)
  await runner.pass(agent, undefined, true) // boundary 2: due again, failures 2 → retry in 2
  assert.equal(engine.calls.length, 2)
  await runner.pass(agent, undefined, true) // boundary 3: backing off
  assert.equal(engine.calls.length, 2)
  await runner.pass(agent, undefined, true) // boundary 4: due again, failures 3 → retry in 4
  assert.equal(engine.calls.length, 3)
  for (let boundary = 5; boundary <= 7; boundary += 1) await runner.pass(agent, undefined, true)
  assert.equal(engine.calls.length, 3, 'still backing off inside the 4-boundary delay')
  await runner.pass(agent, undefined, true) // boundary 8: due again, failures 4 → retry in 8
  assert.equal(engine.calls.length, 4)
  assert.equal(logs.filter((line) => line.includes('retrying')).length, 4)
})

test('a task whose end call carries no summary is skipped, not folded', async () => {
  const sim = new Sim()
  sim.user()
  sim.begin('no summary')
  sim.work(3)
  sim.end()
  assert.equal(sim.state.tasks.T1?.status, 'queued')
  const { runner, engine, logs } = runnerOf(sim)
  const report = await runner.pass(agentOf(sim), undefined, true)
  assert.deepEqual(report.skipped, ['T1'])
  assert.equal(engine.calls.length, 0)
  assert.match(logs[0] ?? '', /no usable summary/)
})

test('a fold node that is not smaller than its span never reaches the engine', async () => {
  const sim = new Sim()
  const h = harnessOf(sim, { meter: fakeMeter() })
  await h.batch([{ name: 'task_begin', args: { title: 'tiny span' } }])
  sim.work(4)
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])
  assert.equal(sim.state.tasks.T1?.status, 'queued')
  // The host prices the span with its own meter; this estimator claims the node text is bigger.
  const estimator = {
    regionTokens: (
      /** @type {any} */ _session,
      /** @type {readonly number[]} */ _nodes,
      /** @type {number} */ from,
      /** @type {number} */ to,
    ) => (to - from + 1) * 1000,
    text: () => 99_999,
  }
  const { runner, engine, logs } = runnerOf(sim, { estimator })
  const report = await runner.pass(agentOf(sim), undefined, true)
  assert.deepEqual(report.skipped, ['T1'])
  assert.equal(engine.calls.length, 0)
  assert.match(logs[0] ?? '', /would not be smaller/)
})

test('delegate tasks are left alone for M5', async () => {
  const sim = new Sim()
  const h = harnessOf(sim, { meter: fakeMeter() })
  await h.batch([{ name: 'task_begin', args: { title: 'delegated' } }])
  sim.work(4)
  await h.batch([{ name: 'task_end', args: { summary: 'Too short.' } }])
  assert.equal(sim.state.tasks.T1?.status, 'delegate')
  const { runner, engine } = runnerOf(sim)
  const report = await runner.pass(agentOf(sim), undefined, true)
  assert.equal(report.folded, 0)
  assert.equal(engine.calls.length, 0)
  assert.equal(sim.state.tasks.T1?.status, 'delegate')
})

test('a pass already running for the session is not re-entered', async () => {
  const sim = new Sim()
  const h = harnessOf(sim, { meter: fakeMeter() })
  await h.batch([{ name: 'task_begin', args: { title: 'once' } }])
  sim.work(4)
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])
  const { runner, engine } = runnerOf(sim)
  const agent = agentOf(sim)
  const [first, second] = await Promise.all([
    runner.pass(agent, undefined, true),
    runner.pass(agent, undefined, true),
  ])
  assert.equal(first.folded + second.folded, 1, 'only one pass folded anything')
  assert.equal(engine.calls.length, 1)
})

test('pre-step folds and then returns the host decision unchanged', async () => {
  const sim = new Sim()
  const h = harnessOf(sim, { meter: fakeMeter() })
  await h.batch([{ name: 'task_begin', args: { title: 'pre-step' } }])
  sim.work(4)
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])
  sim.say() // the report makes the task due outside turn-stopping as well
  const { runner, engine } = runnerOf(sim)
  const decision = { messages: [{ role: 'user', content: [] }], modelSelection: undefined }
  const returned = await runner.preStep(
    { agent: agentOf(sim), turn: 1, step: 2, signal: undefined },
    async () => decision,
  )
  assert.equal(returned, decision, 'the very object next() produced')
  assert.equal(engine.calls.length, 1)
  assert.equal(sim.state.tasks.T1?.status, 'folded')
})

test('turn-stopping folds a task the model never reported on', async () => {
  const sim = new Sim()
  const h = harnessOf(sim, { meter: fakeMeter() })
  await h.batch([{ name: 'task_begin', args: { title: 'silent' } }])
  sim.work(4)
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])
  assert.equal(sim.state.tasks.T1?.reported, false, 'no message after the closing batch yet')

  const { runner, engine } = runnerOf(sim)
  const agent = agentOf(sim)
  await runner.preStep({ agent, turn: 1, step: 9, signal: undefined }, async () => ({}))
  assert.equal(engine.calls.length, 0, 'pre-step waits for the report')
  await runner.turnStopping({ agent, turn: 1, signal: undefined })
  assert.equal(engine.calls.length, 1)
  assert.equal(sim.state.tasks.T1?.status, 'folded')
})

test('the handlers never snapshot or iterate the log', async () => {
  const sim = new Sim()
  const h = harnessOf(sim, { meter: fakeMeter() })
  await h.batch([{ name: 'task_begin', args: { title: 'guarded' } }])
  sim.work(4)
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])
  sim.say()

  const base = sessionOf(sim)
  const guarded = {
    id: base.id,
    surface: base.surface,
    eventAt: base.eventAt,
    deriveEventMessage: base.deriveEventMessage,
    get snapshotEvents() {
      throw new Error('the fold path must not snapshot the log')
    },
    get events() {
      throw new Error('the fold path must not iterate the log')
    },
  }
  /** @type {string[]} */
  const logs = []
  const estimator = new SpanEstimator(fakeMeter())
  const engine = successEngine(sim)
  const runner = createFoldRunner({
    stateOf: async () => sim.state,
    engine: async () => engine,
    estimator,
    logger: { warn: (/** @type {string} */ message) => logs.push(message) },
  })
  const agent = { session: guarded, options: {} }
  const returned = await runner.preStep({ agent, turn: 1, step: 2 }, async () => 'decision')
  assert.equal(returned, 'decision')
  await runner.turnStopping({ agent, turn: 1 })
  assert.equal(engine.calls.length, 1)
  assert.deepEqual(logs, [])
})

test('a slow pass is reported against the 100 ms budget', async () => {
  const sim = new Sim()
  const h = harnessOf(sim, { meter: fakeMeter() })
  await h.batch([{ name: 'task_begin', args: { title: 'slow' } }])
  sim.work(4)
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])
  let clock = 0
  const { runner, logs } = runnerOf(sim, { now: () => (clock += 400) })
  await runner.turnStopping({ agent: agentOf(sim), turn: 1 })
  assert.match(logs.join('\n'), /took 400 ms \(budget 100 ms\)/)
})

test('a failing pass is logged and never breaks the boundary', async () => {
  const sim = new Sim()
  /** @type {string[]} */
  const logs = []
  const runner = createFoldRunner({
    stateOf: async () => {
      throw new Error('projection unavailable')
    },
    engine: async () => ({
      fold: async () => ({}),
      reject: async () => ({}),
      balancedBefore: () => true,
      balancedAfter: () => true,
      classify: () => 'other',
    }),
    estimator: new SpanEstimator(fakeMeter()),
    logger: { warn: (/** @type {string} */ message) => logs.push(message) },
  })
  const returned = await runner.preStep({ agent: agentOf(sim), turn: 1, step: 1 }, async () => 'ok')
  assert.equal(returned, 'ok')
  assert.match(logs[0] ?? '', /fold pass failed: projection unavailable/)
})

test('without an engine nothing folds and nothing is logged', async () => {
  const sim = new Sim()
  const h = harnessOf(sim, { meter: fakeMeter() })
  await h.batch([{ name: 'task_begin', args: { title: 'no engine' } }])
  sim.work(4)
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])
  /** @type {string[]} */
  const logs = []
  const runner = createFoldRunner({
    stateOf: async () => sim.state,
    engine: async () => null,
    estimator: new SpanEstimator(fakeMeter()),
    logger: { warn: (/** @type {string} */ message) => logs.push(message) },
  })
  const report = await runner.pass(agentOf(sim), undefined, true)
  assert.deepEqual(report, { folded: 0, busy: false, skipped: [] })
  assert.deepEqual(logs, [])
})

// ---------------------------------------------------------------------------
// Two-phase delegate folds (docs/03 §5.4, docs/adr/0006)

test('a delegate generation starts without blocking the pass', async () => {
  const sim = await delegateTask()
  const ctl = delegateOf()
  const { runner, engine } = runnerOf(sim, { delegate: ctl.delegate })

  const pass = runner.pass(agentOf(sim), undefined, true)
  const report = await awaitWithinMicrotasks(pass, 'the pass must not wait for the generation')
  assert.deepEqual(report, { folded: 0, busy: false, skipped: [] })
  assert.equal(ctl.starts.length, 1, 'one generation started')
  assert.equal(at(ctl.starts, 0).task.id, 'T1')
  assert.equal(engine.calls.length, 0, 'the pass folded nothing while the generation is pending')
  assert.equal(sim.state.tasks.T1?.status, 'delegate')
})

test('the next boundary commits the generated blocks for the same region', async () => {
  const sim = await delegateTask()
  const ctl = delegateOf()
  const { runner, engine } = runnerOf(sim, { delegate: ctl.delegate })
  const agent = agentOf(sim)

  const first = await runner.pass(agent, undefined, true)
  assert.equal(first.folded, 0)
  assert.equal(engine.calls.length, 0)
  assert.equal(ctl.starts.length, 1)
  const region = at(ctl.starts, 0).region
  const blocks = [{ type: 'text', text: '## Delegated\nSummarized by the background call.' }]

  // The runner owns the region key: a key echoed by the summarizer must not steer the commit.
  ctl.resolve(0, { blocks, regionKey: 'not-the-key-the-runner-computed' })
  await flushMicrotasks()
  assert.equal(sim.state.tasks.T1?.status, 'delegate', 'settling a generation commits nothing by itself')

  const second = await runner.pass(agent, undefined, true)
  assert.equal(second.folded, 1)
  assert.equal(engine.calls.length, 1)
  assert.equal(engine.calls[0].start, region.start)
  assert.equal(engine.calls[0].end, region.end)
  assert.deepEqual(engine.calls[0].blocks, blocks)
  assert.equal(sim.state.tasks.T1?.status, 'folded')
  assert.equal(ctl.starts.length, 1, 'the generated text is reused, not regenerated')
})

test('a region an external compaction replaced is never committed twice', async () => {
  const sim = await delegateTask()
  const ctl = delegateOf()
  const { runner, engine } = runnerOf(sim, { delegate: ctl.delegate })
  const agent = agentOf(sim)

  await runner.pass(agent, undefined, true)
  assert.equal(ctl.starts.length, 1)
  const region = at(ctl.starts, 0).region

  // Another compaction swallows the delegate task's own span while its summary is generated.
  sim.compact(region.start, region.end)
  // The host replacement covers the whole span, so the projection records a fold of T1 by that
  // other transaction (not an absorbed task: nothing outside the span was shadowed).
  assert.equal(sim.state.tasks.T1?.status, 'folded')
  assert.equal(sim.state.folds[0]?.taskId, 'T1')

  const blocks = [{ type: 'text', text: '## Stale\nThis text describes a surface that has moved.' }]
  ctl.resolve(0, { blocks })
  await flushMicrotasks()

  const report = await runner.pass(agent, undefined, true)
  assert.equal(report.folded, 0)
  assert.equal(engine.calls.length, 0, 'the generated text never reached foldRegion')
  assert.equal(sim.state.tasks.T1?.status, 'folded', 'the external compaction folded the task')
  assert.equal(ctl.starts.length, 1, 'a task that left the waiting set starts nothing new')

  await runner.pass(agent, undefined, true)
  assert.equal(ctl.starts.length, 1)
})

test('replacing a node inside the region drops the generated text', async () => {
  const sim = await delegateTask()
  const ctl = delegateOf()
  const { runner, engine } = runnerOf(sim, { delegate: ctl.delegate })
  const agent = agentOf(sim)

  await runner.pass(agent, undefined, true)
  assert.equal(ctl.starts.length, 1)
  const first = at(ctl.starts, 0)
  // The pruner replaces one result inside the span while the summary is generated, keeping every
  // boundary and index in place. The region key has to notice the changed node list.
  sim.prune(at(sim.nodes, first.region.startIndex + 1))
  assert.equal(sim.state.tasks.T1?.status, 'delegate')

  const blocks = [{ type: 'text', text: '## Stale\nThis text describes a surface that has moved.' }]
  ctl.resolve(0, { blocks })
  await flushMicrotasks()

  const report = await runner.pass(agent, undefined, true)
  assert.equal(report.folded, 0)
  assert.equal(engine.calls.length, 0, 'the stale text never reached foldRegion')
  assert.equal(sim.state.tasks.T1?.status, 'delegate', 'the task is not folded by the stale text')
  assert.equal(ctl.starts.length, 1, 'the pass that dropped the text starts nothing new')

  // The dropped text is regenerated at a later boundary, now for the changed region.
  await runner.pass(agent, undefined, true)
  assert.equal(ctl.starts.length, 2)
  assert.equal(at(ctl.starts, 1).task.id, 'T1')
  assert.notEqual(at(ctl.starts, 1).region.regionKey, first.region.regionKey)
})

test('nodes appended after the region do not drop a valid summary', async () => {
  const sim = await delegateTask()
  const ctl = delegateOf()
  const { runner, engine } = runnerOf(sim, { delegate: ctl.delegate })
  const agent = agentOf(sim)

  await runner.pass(agent, undefined, true)
  assert.equal(ctl.starts.length, 1)
  const region = at(ctl.starts, 0).region
  const lengthBefore = sim.nodes.length

  // The model keeps writing after the task closed; nothing inside the region changed.
  sim.work(2)
  assert.equal(sim.nodes.length, lengthBefore + 4)

  const blocks = [{ type: 'text', text: '## Kept\nThis text still describes the region.' }]
  ctl.resolve(0, { blocks })
  await flushMicrotasks()

  const report = await runner.pass(agent, undefined, true)
  assert.equal(report.folded, 1)
  assert.equal(engine.calls.length, 1)
  assert.equal(engine.calls[0].start, region.start)
  assert.equal(engine.calls[0].end, region.end)
  assert.deepEqual(engine.calls[0].blocks, blocks)
  assert.equal(sim.state.tasks.T1?.status, 'folded')
  assert.equal(ctl.starts.length, 1, 'appending after the region does not regenerate')
})

test('a failed generation is recorded as a durable attempt', async () => {
  const sim = await delegateTask()
  const ctl = delegateOf()
  const engine = rejectEngine(sim)
  const { runner } = runnerOf(sim, { engine, delegate: ctl.delegate })
  const agent = agentOf(sim)

  await runner.pass(agent, undefined, true)
  assert.equal(ctl.starts.length, 1)
  const region = at(ctl.starts, 0).region
  ctl.resolve(0, null)
  await flushMicrotasks()

  const report = await runner.pass(agent, undefined, true)
  assert.equal(report.folded, 0)
  assert.deepEqual(engine.rejects, [{ start: region.start, end: region.end }])
  assert.equal(engine.calls.length, 0, 'a failed generation never reaches foldRegion')
  assert.equal(sim.state.tasks.T1?.status, 'delegate')
  assert.equal(sim.state.tasks.T1?.failures, 1, 'the host recorded one failed compaction attempt')
})

test('at most one generation is in flight per session', async () => {
  const sim = await twoDelegateTasks()
  const ctl = delegateOf()
  const { runner, engine } = runnerOf(sim, { delegate: ctl.delegate })
  const agent = agentOf(sim)

  await runner.pass(agent, undefined, true)
  assert.equal(ctl.starts.length, 1, 'only the first due delegate task starts')
  assert.equal(at(ctl.starts, 0).task.id, 'T1')

  await runner.pass(agent, undefined, true)
  assert.equal(ctl.starts.length, 1, 'a generation is already in flight; the second task waits')

  ctl.resolve(0, { blocks: [{ type: 'text', text: '## First\nSummarized.' }] })
  await flushMicrotasks()
  const report = await runner.pass(agent, undefined, true)
  assert.equal(report.folded, 1)
  assert.equal(engine.calls.length, 1, 'only the committed first task reached foldRegion')
  assert.equal(ctl.starts.length, 2, 'the second task gets its turn once the first generation ended')
  assert.equal(at(ctl.starts, 1).task.id, 'T2')
  assert.equal(sim.state.tasks.T1?.status, 'folded')
  assert.equal(sim.state.tasks.T2?.status, 'delegate')
})

test('without the delegate seam a delegate task waits and nothing is logged', async () => {
  const sim = await delegateTask()
  const { runner, engine, logs } = runnerOf(sim)
  const agent = agentOf(sim)

  await runner.pass(agent, undefined, true)
  await runner.pass(agent, undefined, true)
  assert.equal(engine.calls.length, 0)
  assert.equal(sim.state.tasks.T1?.status, 'delegate')
  assert.deepEqual(logs, [])
})

test('a pass that folds a queued task first never hands a stale region to start', async () => {
  const sim = await nestedDelegateTask()
  const ctl = delegateOf()
  const engine = successEngine(sim)
  const fold = engine.fold
  /** @type {number[]} */
  const startsAtCommit = []
  // The host's compaction transaction commits asynchronously: yield before applying the
  // replacement. Phase 1 has already started the generation against the current surface, so the
  // later fold must not be preceded by another start.
  engine.fold = async (/** @type {any} */ request) => {
    await Promise.resolve()
    startsAtCommit.push(ctl.starts.length)
    return fold(request)
  }
  const { runner } = runnerOf(sim, { engine, delegate: ctl.delegate })
  const agent = agentOf(sim)

  const first = await runner.pass(agent, undefined, true)
  assert.equal(first.folded, 1, 'the queued inner task folds in this pass')
  assert.equal(sim.state.tasks.T2?.status, 'folded')
  assert.equal(sim.state.tasks.T1?.status, 'delegate')
  assert.equal(ctl.starts.length, 1)
  assert.deepEqual(startsAtCommit, [1], 'the generation started before the queued fold committed')

  // The region handed over resolved against the surface as it was at hand-over time, not against
  // an older or a later one.
  const handed = at(ctl.starts, 0)
  const current = resolveRegion(handed.task, handed.nodes)
  assert.ok(current.kind === 'fold')
  assert.deepEqual(boundsOf(handed.region), boundsOf(current))
  const moved = resolveRegion(handed.task, sim.nodes)
  assert.ok(moved.kind === 'fold')
  assert.notDeepEqual(boundsOf(handed.region), boundsOf(moved))

  const blocks = [{ type: 'text', text: '## Late\nThe pre-fold region summary.' }]
  ctl.resolve(0, { blocks })
  await flushMicrotasks()

  const second = await runner.pass(agent, undefined, true)
  assert.equal(second.folded, 0)
  assert.equal(ctl.starts.length, 1, 'nothing is started against the moved region')
  assert.equal(engine.calls.length, 1, 'only the queued fold reached foldRegion')
  assert.equal(sim.state.tasks.T1?.status, 'delegate')
})

test('supports() returning false starts nothing and logs nothing', async () => {
  const sim = await delegateTask()
  const ctl = delegateOf({ supports: () => false })
  const { runner, engine, logs } = runnerOf(sim, { delegate: ctl.delegate })
  const agent = agentOf(sim)

  await runner.pass(agent, undefined, true)
  await runner.pass(agent, undefined, true)
  assert.equal(ctl.starts.length, 0)
  assert.equal(ctl.supportCalls(), 1, 'the summarizer capability is probed once per process')
  assert.equal(engine.calls.length, 0)
  assert.equal(sim.state.tasks.T1?.status, 'delegate')
  assert.deepEqual(logs, [])
})

test('the generated summary carries its provider usage into the fold transaction', async () => {
  // The host records `compaction/summary.data.usage` from the summarize result; that row is the
  // only place the plugin's cache-hit can be audited (docs/03 §12 invariant 9), so the delegate
  // seam's usage must reach `foldRegion` unchanged.
  const sim = await delegateTask()
  const ctl = delegateOf()
  const { runner, engine } = runnerOf(sim, { delegate: ctl.delegate })
  const agent = agentOf(sim)
  await runner.pass(agent, undefined, true)
  const usage = { inputTokens: 42, cacheReadTokens: 900, cacheWriteTokens: 0, totalTokens: 942 }
  ctl.resolve(0, { blocks: [{ type: 'text', text: '## Done\nGenerated.' }], usage })
  await flushMicrotasks()
  await runner.pass(agent, undefined, true)
  assert.equal(engine.calls.length, 1)
  assert.deepEqual(engine.calls[0].usage, usage, 'usage is forwarded verbatim')
})
