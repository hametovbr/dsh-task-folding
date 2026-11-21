// The runner's retry, skip, wait and prune paths (docs/03 §5.2–§5.5, §11, docs/09 T4). Every case
// drives the real `createFoldRunner().pass`; the fakes are reduced copies from
// test/fold-runner.test.js (`runnerOf`, `successEngine`, `delegateOf`, `agentOf`,
// `flushMicrotasks`, the task builders), kept local so this file asserts independently of it.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SpanEstimator } from '../host/estimate.js'
import { createFoldRunner } from '../host/fold-runner.js'
import { resolveRegion } from '../host/planner.js'
import { Sim } from './fixtures/sim.js'
import { fakeMeter, harnessOf, sessionOf } from './fixtures/tools.js'

/** A summary long enough to be usable (copied from test/fold-runner.test.js). */
const SUMMARY = `## Done\n${'Summarized the work with its changed paths and the reason for each choice. '.repeat(3)}`

/**
 * @param {Sim} sim
 * @param {{ engine?: any, delegate?: any, now?: () => number }} [options]
 */
function runnerOf(sim, options = {}) {
  /** @type {string[]} */
  const logs = []
  const engine = options.engine ?? successEngine(sim)
  const runner = createFoldRunner({
    stateOf: async () => sim.state,
    engine: async () => engine,
    estimator: new SpanEstimator(fakeMeter()),
    logger: { warn: (/** @type {string} */ message) => logs.push(message) },
    now: options.now ?? (() => 0),
    delegate: options.delegate,
  })
  return { runner, logs, engine }
}

/**
 * The happy-path engine: records the request, applies the replacement.
 *
 * @param {Sim} sim
 */
function successEngine(sim) {
  /** @type {{ start: number, end: number, blocks: any[] }[]} */
  const calls = []
  return {
    calls,
    /**
     * @param {any} _agent
     * @param {number} start
     * @param {number} end
     * @param {any[]} blocks
     * @param {any} _route
     * @param {AbortSignal | undefined} _signal
     * @param {any} [_usage]
     */
    async foldRegion(_agent, start, end, blocks, _route, _signal, _usage) {
      calls.push({ start, end, blocks })
      sim.compact(start, end)
      return { start, end }
    },
    balancedBefore: () => true,
    balancedAfter: () => true,
    /** @param {any} _agent @param {number} _start @param {number} _end */
    async rejectRegion(_agent, _start, _end) {
      throw new Error('this test never records a failed delegate generation')
    },
    /** @returns {'busy' | 'summary' | 'other'} */
    classify: () => 'other',
  }
}

/** @param {Sim} sim */
function agentOf(sim) {
  return { session: sessionOf(sim), options: { provider: 'opt-provider', model: 'opt-model' } }
}

/**
 * A delegate seam whose generations the test settles explicitly: no timers, no network.
 *
 * @param {{ supports?: () => boolean, throwSupports?: boolean, onStart?: (input: { task: any, region: any, sim: Sim }) => void, sim?: Sim }} [options]
 */
function delegateOf(options = {}) {
  /** @type {{ task: any, region: any }[]} */
  const starts = []
  /** @type {((result: { blocks: any[] } | null) => void)[]} */
  const settle = []
  let supportCalls = 0
  const delegate = {
    supports() {
      supportCalls += 1
      if (options.throwSupports === true) throw new Error('no summarizer can be built')
      return options.supports === undefined ? true : options.supports()
    },
    /**
     * @param {any} _agent
     * @param {any} task
     * @param {any} region
     * @param {AbortSignal | undefined} _signal
     */
    start(_agent, task, region, _signal) {
      starts.push({ task, region })
      if (options.onStart !== undefined && options.sim !== undefined)
        options.onStart({ task, region, sim: options.sim })
      return new Promise((resolve) => settle.push(resolve))
    },
  }
  return {
    delegate,
    starts,
    supportCalls: () => supportCalls,
    /**
     * @param {number} index
     * @param {{ blocks: any[] } | null} result
     */
    resolve(index, result) {
      const settleOne = settle[index]
      if (settleOne === undefined) throw new Error(`no pending generation at ${index}`)
      settleOne(result)
    },
  }
}

/** Let the runner's deferred microtasks run; no timer is involved. */
async function flushMicrotasks() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

/** @returns {Promise<Sim>} a session with one closed, reported `queued` task. */
async function queuedTask() {
  const sim = new Sim()
  const h = harnessOf(sim, { meter: fakeMeter() })
  await h.batch([{ name: 'task_begin', args: { title: 'queued' } }])
  sim.work(4)
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])
  assert.equal(sim.state.tasks.T1?.status, 'queued')
  return sim
}

/** @returns {Promise<Sim>} a session with one closed `delegate` task (T1). */
async function delegateTask() {
  const sim = new Sim()
  const h = harnessOf(sim, { meter: fakeMeter() })
  await h.batch([{ name: 'task_begin', args: { title: 'delegated' } }])
  sim.work(4)
  await h.batch([{ name: 'task_end', args: { summary: 'Too short.' } }])
  assert.equal(sim.state.tasks.T1?.status, 'delegate')
  return sim
}

/** @returns {Promise<Sim>} a session with two closed `delegate` tasks (T1, T2). */
async function twoDelegateTasks() {
  const sim = new Sim()
  const h = harnessOf(sim, { meter: fakeMeter() })
  for (const title of ['first', 'second']) {
    await h.batch([{ name: 'task_begin', args: { title } }])
    sim.work(4)
    await h.batch([{ name: 'task_end', args: { summary: 'Too short.' } }])
  }
  assert.equal(sim.state.tasks.T1?.status, 'delegate')
  assert.equal(sim.state.tasks.T2?.status, 'delegate')
  return sim
}

/** @returns {Promise<Sim>} a session with three closed `delegate` tasks (T1…T3). */
async function threeDelegateTasks() {
  const sim = new Sim()
  const h = harnessOf(sim, { meter: fakeMeter() })
  for (const title of ['first', 'second', 'third']) {
    await h.batch([{ name: 'task_begin', args: { title } }])
    sim.work(4)
    await h.batch([{ name: 'task_end', args: { summary: 'Too short.' } }])
  }
  for (const id of ['T1', 'T2', 'T3']) assert.equal(sim.state.tasks[id]?.status, 'delegate')
  return sim
}

/**
 * A fold pass with one task closed but not yet folded, plus a settlement of the queued task's
 * engine failure: the simplified `successEngine` with one overridable seam.
 *
 * @param {Sim} sim
 * @param {{ balancedBefore?: () => boolean, balancedAfter?: () => boolean, classify?: () => string }} [overrides]
 */
function engineWith(sim, overrides = {}) {
  const engine = successEngine(sim)
  return {
    ...engine,
    balancedBefore: overrides.balancedBefore ?? engine.balancedBefore,
    balancedAfter: overrides.balancedAfter ?? engine.balancedAfter,
    classify: overrides.classify ?? engine.classify,
  }
}

/**
 * The delay and failure number of one backoff log line.
 *
 * @param {string} line
 * @returns {{ failures: number, delay: number }}
 */
function backoffOf(line) {
  const match = /failed \(attempt (\d+)\), retrying in (\d+) boundaries/.exec(line)
  if (match === null) throw new Error(`not a backoff line: ${line}`)
  return { failures: Number(match[1]), delay: Number(match[2]) }
}

/**
 * @template T
 * @param {readonly T[]} list
 * @param {number} index
 * @returns {T}
 */
function member(list, index) {
  const value = list[index]
  if (value === undefined) throw new Error(`no element ${index}`)
  return value
}

// ---------------------------------------------------------------------------
// skipOnce

test('a skip is logged once and never retried in this process', async () => {
  const sim = await queuedTask()
  const engine = engineWith(sim, { balancedAfter: () => false })
  const { runner, logs } = runnerOf(sim, { engine })
  const agent = agentOf(sim)

  const first = await runner.pass(agent, undefined, true)
  assert.deepEqual(first, { folded: 0, busy: false, skipped: ['T1'] })
  assert.equal(engine.calls.length, 0, 'the task never reaches foldRegion')
  assert.equal(sim.state.tasks.T1?.status, 'queued', 'the task waits, it is not folded')
  assert.equal(logs.length, 1)
  assert.match(
    member(logs, 0),
    /folding T1 is skipped at surface version \d+: region is not tool-pairing balanced/,
  )

  // docs/03 §5.2/§5.3: the task is marked unfoldable for the process, so the next boundary neither
  // checks nor logs it again.
  const second = await runner.pass(agent, undefined, true)
  assert.deepEqual(second, { folded: 0, busy: false, skipped: [] })
  assert.equal(logs.length, 1, 'the reason is logged once')
  assert.equal(engine.calls.length, 0)
})

test('the before and after tool-pairing edges cannot be told apart in the skip reason', async () => {
  /** @type {string[][]} */
  const reasons = []
  for (const edge of ['before', 'after']) {
    const sim = await queuedTask()
    const engine = engineWith(
      sim,
      edge === 'before' ? { balancedBefore: () => false } : { balancedAfter: () => false },
    )
    const { runner, logs } = runnerOf(sim, { engine })
    const report = await runner.pass(agentOf(sim), undefined, true)
    assert.deepEqual(report.skipped, ['T1'])
    assert.equal(engine.calls.length, 0)
    reasons.push(logs)
  }
  // `balanced()` folds both edges into one boolean (host/fold-runner.js:585-591), so an unbalanced
  // *after* edge and an unbalanced *before* edge produce the same log line. Reported as a finding:
  // the runner cannot say which invariant broke.
  assert.deepEqual(reasons[0], reasons[1])
  assert.match(member(member(reasons, 0), 0), /region is not tool-pairing balanced/)

  // The delegate path takes the same decision before a generation starts (no pending summary).
  const sim = await delegateTask()
  const ctl = delegateOf()
  const engine = engineWith(sim, { balancedAfter: () => false })
  const { runner, logs } = runnerOf(sim, { engine, delegate: ctl.delegate })
  const report = await runner.pass(agentOf(sim), undefined, true)
  assert.deepEqual(report.skipped, ['T1'])
  assert.equal(ctl.starts.length, 0, 'nothing is generated for an unbalanced region')
  assert.deepEqual(logs, member(reasons, 1))
})

// ---------------------------------------------------------------------------
// Backoff

test('an unexpected failure backs off 1, 2, 4 and then caps at MAX_BACKOFF_BOUNDARIES', async () => {
  const sim = await queuedTask()
  const engine = engineWith(sim)
  engine.foldRegion = async () => {
    engine.calls.push({ start: 0, end: 0, blocks: [] })
    throw new Error('boom')
  }
  const { runner, logs } = runnerOf(sim, { engine })
  const agent = agentOf(sim)

  /** @type {number[]} */
  const callsAtBoundary = []
  for (let pass = 1; pass <= 24; pass += 1) {
    await runner.pass(agent, undefined, true)
    callsAtBoundary.push(engine.calls.length)
    assert.equal(runner.boundary(), pass)
  }
  const attempts = logs.map(backoffOf)
  assert.deepEqual(
    attempts,
    [
      { failures: 1, delay: 1 },
      { failures: 2, delay: 2 },
      { failures: 3, delay: 4 },
      { failures: 4, delay: 8 },
      { failures: 5, delay: 8 },
      { failures: 6, delay: 8 },
    ],
    'the delay doubles up to the cap and stays there',
  )
  assert.deepEqual(
    callsAtBoundary,
    [1, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5, 6],
    'the retry lands on the boundary the log announced',
  )
  assert.equal(sim.state.tasks.T1?.status, 'queued', 'a failure never folds the task')
})

test('a successful fold after backoff ends the retries for good', async () => {
  const sim = await queuedTask()
  const engine = engineWith(sim)
  const success = engine.foldRegion
  let attempts = 0
  engine.foldRegion = async (
    /** @type {any} */ agent,
    /** @type {number} */ start,
    /** @type {number} */ end,
    /** @type {any[]} */ blocks,
    /** @type {any} */ route,
    /** @type {AbortSignal | undefined} */ signal,
  ) => {
    attempts += 1
    if (attempts <= 2) {
      engine.calls.push({ start, end, blocks })
      throw new Error('boom')
    }
    return success(agent, start, end, blocks, route, signal, undefined)
  }
  const { runner, logs } = runnerOf(sim, { engine })
  const agent = agentOf(sim)

  assert.deepEqual(await runner.pass(agent, undefined, true), { folded: 0, busy: false, skipped: [] })
  assert.deepEqual(await runner.pass(agent, undefined, true), { folded: 0, busy: false, skipped: [] })
  assert.deepEqual(logs.map(backoffOf), [
    { failures: 1, delay: 1 },
    { failures: 2, delay: 2 },
  ])
  await runner.pass(agent, undefined, true) // boundary 3: inside the two-boundary delay
  assert.equal(attempts, 2)

  const folded = await runner.pass(agent, undefined, true) // boundary 4: the retry succeeds
  assert.deepEqual(folded, { folded: 1, busy: false, skipped: [] })
  assert.equal(sim.state.tasks.T1?.status, 'folded')
  assert.equal(attempts, 3)

  for (let pass = 0; pass < 4; pass += 1) await runner.pass(agent, undefined, true)
  assert.equal(attempts, 3, 'a folded task never retries')
  assert.equal(logs.length, 2, 'a success adds no line')
  // The backoff record itself is not cleared in code (there is no delete on `backoff` and no
  // re-exported state to read it): the observable guarantee is that a successful fold ends the
  // retries, which is what this asserts. Reported, not fixed.
})

// ---------------------------------------------------------------------------
// waitOnce

test('a held lock is explained once for the process, not once per pass', async () => {
  const sim = await queuedTask()
  const engine = engineWith(sim)
  engine.foldRegion = async () => {
    engine.calls.push({ start: 0, end: 0, blocks: [] })
    throw new Error('the compaction lock is held')
  }
  engine.classify = () => 'busy'
  const { runner, logs } = runnerOf(sim, { engine })
  const agent = agentOf(sim)

  const first = await runner.pass(agent, undefined, true)
  assert.deepEqual(first, { folded: 0, busy: true, skipped: [] })
  assert.equal(engine.calls.length, 2, 'one attempt and one retry inside the pass')
  assert.equal(logs.length, 1)
  assert.match(member(logs, 0), /folding T1 waits: the compaction lock is held by another compaction/)

  const second = await runner.pass(agent, undefined, true)
  assert.deepEqual(second, { folded: 0, busy: true, skipped: [] })
  assert.equal(engine.calls.length, 4, 'the next boundary tries again')
  assert.equal(logs.length, 1, 'still one explanation for the process (docs/03 §5.5)')
  assert.equal(sim.state.tasks.T1?.status, 'queued')
})

// ---------------------------------------------------------------------------
// A terminal task while a generation is in flight

test('a task that becomes terminal while its generation is in flight is never folded by it', async () => {
  // Outer delegate T1, inner queued T2: T2 folds in the pass, and the delegate generation's start
  // (the only await inside the pass) lets another transaction fold T1. Phase 2 re-reads T1 as
  // terminal and skips it instead of folding it twice.
  const sim = new Sim()
  const h = harnessOf(sim, { meter: fakeMeter() })
  await h.batch([{ name: 'task_begin', args: { title: 'outer' } }])
  await h.batch([{ name: 'task_begin', args: { title: 'inner' } }])
  sim.work(4)
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])
  sim.work(4)
  await h.batch([{ name: 'task_end', args: { summary: 'Too short.' } }])
  assert.equal(sim.state.tasks.T1?.status, 'delegate')
  assert.equal(sim.state.tasks.T2?.status, 'queued')

  const ctl = delegateOf({
    sim,
    onStart({ region, sim: innerSim }) {
      innerSim.compact(region.start, region.end) // the competing transaction wins the race
    },
  })
  const engine = engineWith(sim)
  const { runner, logs } = runnerOf(sim, { engine, delegate: ctl.delegate })
  const agent = agentOf(sim)

  const report = await runner.pass(agent, undefined, true)
  // The competing transaction folded the whole outer span; T2's cuts no longer resolve on the
  // surface the pass re-read, so it is skipped **at that surface version** — not for the process.
  // A later replacement moves the epoch and the task is looked at again (the F9 acceptance).
  assert.deepEqual(report, { folded: 0, busy: false, skipped: ['T2'] })
  assert.equal(engine.calls.length, 0, 'the runner does not fold a task whose region moved')
  assert.equal(sim.state.tasks.T1?.status, 'folded', 'the external fold is durable')
  assert.equal(sim.state.folds.length, 1, 'only the external fold exists')
  assert.equal(logs.length, 1)
  assert.match(member(logs, 0), /folding T2 is skipped at surface version \d+/)

  // The generation still settles later; the runner already holds no use for it.
  ctl.resolve(0, { blocks: [{ type: 'text', text: '## Stale\nToo late to matter.' }] })
  await flushMicrotasks()
  const next = await runner.pass(agent, undefined, true)
  assert.deepEqual(next, { folded: 0, busy: false, skipped: [] }, 'nothing is folded, nothing throws')
  assert.equal(engine.calls.length, 0, 'still nothing reached the engine')
  assert.equal(ctl.starts.length, 1, 'the late text is not a second generation')
})

// ---------------------------------------------------------------------------
// At most one generation per pass

test('one pass starts at most one generation, and the next one waits its turn', async () => {
  const sim = await threeDelegateTasks()
  const ctl = delegateOf()
  const engine = engineWith(sim)
  const { runner } = runnerOf(sim, { engine, delegate: ctl.delegate })
  const agent = agentOf(sim)
  /** @type {number[]} */
  const startsAfterPass = []

  // Two due delegate tasks, no generation yet: phase 1 may start only the first.
  await runner.pass(agent, undefined, true)
  startsAfterPass.push(ctl.starts.length)
  assert.equal(ctl.starts.length, 1)
  assert.equal(member(ctl.starts, 0).task.id, 'T1')

  // A generation is in flight: the pass starts nothing, even though T2 and T3 are due.
  await runner.pass(agent, undefined, true)
  startsAfterPass.push(ctl.starts.length)
  assert.equal(ctl.starts.length, 1, 'the second task waits')

  ctl.resolve(0, { blocks: [{ type: 'text', text: '## First\nSummarized.' }] })
  await flushMicrotasks()
  await runner.pass(agent, undefined, true)
  startsAfterPass.push(ctl.starts.length)
  assert.equal(ctl.starts.length, 2, 'after the first commit the next task gets its turn')
  assert.equal(member(ctl.starts, 1).task.id, 'T2')
  assert.equal(engine.calls.length, 1, 'only the committed first task reached foldRegion')

  // T2's generation is in flight now; the pass starts no third generation.
  await runner.pass(agent, undefined, true)
  startsAfterPass.push(ctl.starts.length)
  assert.equal(ctl.starts.length, 2)

  ctl.resolve(1, { blocks: [{ type: 'text', text: '## Second\nSummarized.' }] })
  await flushMicrotasks()
  await runner.pass(agent, undefined, true)
  startsAfterPass.push(ctl.starts.length)
  assert.equal(ctl.starts.length, 3)
  assert.equal(member(ctl.starts, 2).task.id, 'T3')
  assert.equal(engine.calls.length, 2)

  for (let i = 1; i < startsAfterPass.length; i += 1) {
    const delta = member(startsAfterPass, i) - member(startsAfterPass, i - 1)
    assert.ok(delta <= 1, `pass ${i} started ${delta} generations`)
  }
  // Finish the third task so every generation has a matching commit.
  ctl.resolve(2, { blocks: [{ type: 'text', text: '## Third\nSummarized.' }] })
  await flushMicrotasks()
  const last = await runner.pass(agent, undefined, true)
  assert.deepEqual(last, { folded: 1, busy: false, skipped: [] })
  assert.equal(engine.calls.length, 3)
  for (const id of ['T1', 'T2', 'T3']) assert.equal(sim.state.tasks[id]?.status, 'folded')
})

// ---------------------------------------------------------------------------
// The commit path's edge outcomes

test('a summary whose region stopped balancing before commit is dropped and skipped', async () => {
  const sim = await delegateTask()
  const ctl = delegateOf()
  const engine = engineWith(sim)
  const { runner, logs } = runnerOf(sim, { engine, delegate: ctl.delegate })
  const agent = agentOf(sim)

  await runner.pass(agent, undefined, true) // starts the generation
  ctl.resolve(0, { blocks: [{ type: 'text', text: '## Delegated\nText.' }] })
  await flushMicrotasks()
  engine.balancedBefore = () => false

  const report = await runner.pass(agent, undefined, true)
  assert.deepEqual(report, { folded: 0, busy: false, skipped: ['T1'] })
  assert.equal(engine.calls.length, 0, 'the generated text never reaches foldRegion')
  assert.equal(logs.length, 1)
  assert.match(member(logs, 0), /region is not tool-pairing balanced/)
  const after = await runner.pass(agent, undefined, true)
  assert.deepEqual(after, { folded: 0, busy: false, skipped: [] }, 'the skip lasts for the process')
  assert.equal(ctl.starts.length, 1, 'a skipped task starts no new generation')
})

test('a host refusal at commit drops the pending text and skips the task', async () => {
  const sim = await delegateTask()
  const ctl = delegateOf()
  const engine = engineWith(sim)
  let attempts = 0
  engine.foldRegion = async () => {
    attempts += 1
    throw new Error('summary is not smaller than the shadowed content')
  }
  engine.classify = () => 'summary'
  const { runner, logs } = runnerOf(sim, { engine, delegate: ctl.delegate })
  const agent = agentOf(sim)

  await runner.pass(agent, undefined, true)
  ctl.resolve(0, { blocks: [{ type: 'text', text: '## Delegated\nText.' }] })
  await flushMicrotasks()

  const report = await runner.pass(agent, undefined, true)
  assert.deepEqual(report, { folded: 0, busy: false, skipped: ['T1'] })
  assert.equal(attempts, 1)
  assert.match(member(logs, 0), /the host refused the fold as not smaller than the span/)
  await runner.pass(agent, undefined, true)
  assert.equal(attempts, 1, 'the dropped text is not committed again')
  assert.equal(ctl.starts.length, 1, 'a skipped task is not regenerated')
})

test('a busy commit keeps the generated text and retries it at the next boundary', async () => {
  const sim = await delegateTask()
  const ctl = delegateOf()
  const engine = engineWith(sim)
  const success = engine.foldRegion
  let attempts = 0
  engine.foldRegion = async () => {
    attempts += 1
    throw new Error('the compaction lock is held')
  }
  engine.classify = () => 'busy'
  const { runner, logs } = runnerOf(sim, { engine, delegate: ctl.delegate })
  const agent = agentOf(sim)

  await runner.pass(agent, undefined, true)
  const blocks = [{ type: 'text', text: '## Delegated\nKeep me for the retry.' }]
  ctl.resolve(0, { blocks })
  await flushMicrotasks()

  const busy = await runner.pass(agent, undefined, true)
  assert.deepEqual(busy, { folded: 0, busy: true, skipped: [] })
  assert.equal(attempts, 2, 'one attempt and one retry inside the pass')
  assert.match(member(logs, 0), /waits: the compaction lock is held/)

  // The lock is released: the same generated blocks are committed, without regeneration.
  engine.foldRegion = success
  const region = member(ctl.starts, 0).region
  const folded = await runner.pass(agent, undefined, true)
  assert.deepEqual(folded, { folded: 1, busy: false, skipped: [] })
  assert.equal(attempts, 2, 'no failed attempt on the successful boundary')
  assert.equal(ctl.starts.length, 1, 'the text is reused, not regenerated')
  assert.equal(sim.state.tasks.T1?.status, 'folded')
  assert.deepEqual(engine.calls, [{ start: region.start, end: region.end, blocks }])
})

test('an unexpected commit failure keeps the text and retries it on the backoff', async () => {
  const sim = await delegateTask()
  const ctl = delegateOf()
  const engine = engineWith(sim)
  const success = engine.foldRegion
  let failures = 0
  engine.foldRegion = async () => {
    failures += 1
    throw new Error('the transaction could not start')
  }
  engine.classify = () => 'other'
  const { runner, logs } = runnerOf(sim, { engine, delegate: ctl.delegate })
  const agent = agentOf(sim)

  await runner.pass(agent, undefined, true)
  const blocks = [{ type: 'text', text: '## Delegated\nSurvives a host failure.' }]
  ctl.resolve(0, { blocks })
  await flushMicrotasks()

  await runner.pass(agent, undefined, true) // boundary 2: failure 1, retry in 1
  assert.equal(failures, 1)
  await runner.pass(agent, undefined, true) // boundary 3: failure 2, retry in 2
  assert.equal(failures, 2)
  await runner.pass(agent, undefined, true) // boundary 4: backing off
  assert.equal(failures, 2)
  assert.deepEqual(logs.map(backoffOf), [
    { failures: 1, delay: 1 },
    { failures: 2, delay: 2 },
  ])
  assert.equal(ctl.starts.length, 1, 'the failure never bills a new generation')

  engine.foldRegion = success
  const folded = await runner.pass(agent, undefined, true) // boundary 5: the retry commits
  assert.deepEqual(folded, { folded: 1, busy: false, skipped: [] })
  assert.equal(sim.state.tasks.T1?.status, 'folded')
  const committed = member(engine.calls, 0)
  assert.deepEqual(committed.blocks, blocks, 'the generated text survived the backoff')
})

// ---------------------------------------------------------------------------
// Degradations

test('a summarizer that cannot say whether it is supported leaves delegate tasks waiting', async () => {
  const sim = await delegateTask()
  const ctl = delegateOf({ throwSupports: true })
  const engine = engineWith(sim)
  const { runner, logs } = runnerOf(sim, { engine, delegate: ctl.delegate })
  const agent = agentOf(sim)

  assert.deepEqual(await runner.pass(agent, undefined, true), { folded: 0, busy: false, skipped: [] })
  assert.deepEqual(await runner.pass(agent, undefined, true), { folded: 0, busy: false, skipped: [] })
  assert.equal(ctl.starts.length, 0, 'nothing is started when support cannot be established')
  assert.equal(ctl.supportCalls(), 1, 'the answer is probed once per process')
  assert.equal(engine.calls.length, 0)
  assert.equal(sim.state.tasks.T1?.status, 'delegate')
  assert.deepEqual(logs, [])
})

test('a task whose closing call carries no usable summary is skipped, not thrown', async () => {
  // Two damaged-journal shapes: `arguments` is not JSON, and the recorded `callId` names no block.
  for (const damage of ['arguments', 'callId']) {
    const sim = new Sim()
    const h = harnessOf(sim, { meter: fakeMeter() })
    await h.batch([{ name: 'task_begin', args: { title: 'damaged' } }])
    sim.work(3)
    const callId = 'call_damaged'
    const argumentsText = damage === 'arguments' ? '{not json' : JSON.stringify({ summary: SUMMARY })
    sim.push({
      type: 'assistant/message',
      data: {
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'closing' },
            { type: 'tool-call', id: callId, name: 'task_end', arguments: argumentsText },
          ],
        },
      },
      surfaceOp: 'append',
    })
    const meta = { ...sim.endMeta({}, callId), id: 'T1' }
    if (damage === 'callId') meta.callId = 'call_absent'
    sim.result(callId, { meta, name: 'task_end' })
    assert.equal(sim.state.tasks.T1?.status, 'queued')

    const engine = engineWith(sim)
    const { runner, logs } = runnerOf(sim, { engine })
    const report = await runner.pass(agentOf(sim), undefined, true)
    assert.deepEqual(report, { folded: 0, busy: false, skipped: ['T1'] })
    assert.equal(engine.calls.length, 0)
    assert.match(member(logs, 0), /the task_end call carries no usable summary/)
  }
})

// ---------------------------------------------------------------------------
// A state read that the surface moved under (docs/03 §5.2, §5.5)

test('an external replacement between the state read and the task resolves as inconsistent', async () => {
  // Two due delegate tasks. Phase 1 starts T1's generation; when that start runs (the only await
  // in the pass) another transaction prunes T2's begin-cut. The pass keeps the `state` it read at
  // its start, so T2's old cuts no longer name surface nodes and the runner reports `inconsistent`.
  const sim = await twoDelegateTasks()
  const ctl = delegateOf({
    sim,
    onStart({ sim: innerSim }) {
      const cut = innerSim.state.tasks.T2?.beginCut
      assert.equal(typeof cut, 'number')
      innerSim.prune(/** @type {number} */ (cut))
    },
  })
  const engine = engineWith(sim)
  const { runner, logs } = runnerOf(sim, { engine, delegate: ctl.delegate })
  const agent = agentOf(sim)

  const report = await runner.pass(agent, undefined, true)
  assert.deepEqual(report.skipped, ['T2'])
  assert.equal(ctl.starts.length, 1)
  assert.match(
    member(logs, 0),
    /folding T2 is skipped at surface version \d+: region is inconsistent: a boundary node is not on the surface/,
  )
  // The fresh projection translates the cut, so the task is still foldable: a transient external
  // replacement costs it every future pass in this process. Reported as a finding, not fixed.
  assert.equal(sim.state.tasks.T2?.status, 'delegate')
  const fresh = resolveRegion(/** @type {any} */ (sim.state.tasks.T2), sim.nodes)
  assert.equal(fresh.kind, 'fold')
  const next = await runner.pass(agent, undefined, true)
  assert.deepEqual(next.skipped, [], 'the skipped task is not retried')
  assert.equal(logs.length, 1)
})

test('a pending summary whose region moved under it is dropped as inconsistent', async () => {
  // T2 is a delegate task with a pending summary; T1 is queued and fails its fold while another
  // transaction prunes T2's begin-cut. The pass has not re-read the state after that deferred
  // outcome, so the commit resolves T2's stale cuts and drops the generated text.
  const sim = new Sim()
  const h = harnessOf(sim, { meter: fakeMeter() })
  await h.batch([{ name: 'task_begin', args: { title: 'queued first' } }])
  sim.work(4)
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])
  await h.batch([{ name: 'task_begin', args: { title: 'delegate second' } }])
  sim.work(4)
  await h.batch([{ name: 'task_end', args: { summary: 'Too short.' } }])
  assert.equal(sim.state.tasks.T1?.status, 'queued')
  assert.equal(sim.state.tasks.T2?.status, 'delegate')

  const ctl = delegateOf()
  const engine = engineWith(sim)
  let queuedAttempts = 0
  engine.foldRegion = async (
    /** @type {any} */ _agent,
    /** @type {number} */ start,
    /** @type {number} */ end,
    /** @type {any[]} */ _blocks,
  ) => {
    if (sim.state.tasks.T1?.status === 'queued') {
      queuedAttempts += 1
      engine.calls.push({ start: 0, end: 0, blocks: [] })
      if (queuedAttempts === 2) {
        const cut = sim.state.tasks.T2?.beginCut
        assert.equal(typeof cut, 'number')
        sim.prune(/** @type {number} */ (cut))
      }
      throw new Error('boom')
    }
    engine.calls.push({ start, end, blocks: [] })
    sim.compact(start, end)
    return { start, end }
  }
  engine.classify = () => 'other'
  const { runner, logs } = runnerOf(sim, { engine, delegate: ctl.delegate })
  const agent = agentOf(sim)

  await runner.pass(agent, undefined, true) // starts T2's generation; T1 fails once
  assert.equal(ctl.starts.length, 1)
  const blocks = [{ type: 'text', text: '## Second\nDropped by the stale read.' }]
  ctl.resolve(0, { blocks })
  await flushMicrotasks()

  const report = await runner.pass(agent, undefined, true) // T1 fails again and prunes T2's cut
  assert.deepEqual(report.skipped, ['T2'])
  assert.match(
    member(logs, 2),
    /folding T2 is skipped at surface version \d+: region is inconsistent: a boundary node is not on the surface/,
  )
  assert.equal(engine.calls.length, 2, 'only the two failed queued attempts reached the engine')
  // The skip belongs to the surface version it was decided at: once that moves, the task is examined
  // again and the dropped summary is regenerated instead of waiting forever (docs/08 F9).
  sim.work(2)
  const after = await runner.pass(agent, undefined, true)
  assert.ok(ctl.starts.length > 1, 'a task skipped at one epoch is tried again at the next')
  assert.notEqual(after.skipped.includes('T2'), true, 'the same surface version is not skipped twice')
})
