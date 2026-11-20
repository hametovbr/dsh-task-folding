// The fold runner (docs/03 §5.1–5.3): which task folds when, in which order, and what happens
// when the host refuses. A fake engine stands in for the compaction transaction.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SpanEstimator } from '../host/estimate.js'
import { createFoldRunner } from '../host/fold-runner.js'
import { Sim } from './fixtures/sim.js'
import { fakeMeter, harnessOf, sessionOf } from './fixtures/tools.js'

/** A summary long enough to be usable. */
const SUMMARY = `## Done\n${'Summarized the work with its changed paths and the reason for each choice. '.repeat(3)}`

/**
 * @param {Sim} sim
 * @param {{ meter?: any, engine?: any, now?: () => number, estimator?: any }} [options]
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
  })
  return { runner, logs, engine, estimator }
}

/** @param {Sim} sim */
function successEngine(sim) {
  /** @type {any[]} */
  const calls = []
  return {
    calls,
    /**
     * @param {any} agent
     * @param {number} start
     * @param {number} end
     * @param {any[]} blocks
     * @param {any} route
     * @param {AbortSignal | undefined} signal
     */
    async foldRegion(agent, start, end, blocks, route, signal) {
      calls.push({ agent, start, end, blocks, route, signal })
      sim.compact(start, end)
      return { start, end }
    },
    balancedBefore: () => true,
    balancedAfter: () => true,
    /** @returns {'busy' | 'summary' | 'other'} */
    classify: () => 'other',
  }
}

/** @param {Sim} sim @param {Error} error @param {'busy' | 'summary' | 'other'} kind */
function failingEngine(sim, error, kind) {
  const engine = successEngine(sim)
  engine.foldRegion = async () => {
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
    /**
     * @param {any} agent
     * @param {number} start
     * @param {number} end
     * @param {any[]} blocks
     * @param {any} route
     * @param {AbortSignal | undefined} signal
     */
    async foldRegion(agent, start, end, blocks, route, signal) {
      if (busy) {
        busy = false
        success.calls.push({ busy: true })
        throw new Error('busy')
      }
      return success.foldRegion(agent, start, end, blocks, route, signal)
    },
    balancedBefore: success.balancedBefore,
    balancedAfter: success.balancedAfter,
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
  engine.foldRegion = async () => {
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
      foldRegion: async () => ({}),
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
