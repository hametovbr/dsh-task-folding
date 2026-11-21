// The implicit turn fold (docs/03 §5.6, docs/07 Q10): a turn that ends without a task fold is
// summarized by the plugin itself, through the same delegate generation seam a delegate task uses,
// and recorded exactly like the host's own auto compaction — a `compaction/summary` plus a
// replacement of the turn's span, with no `task_end` meta. These tests drive the real
// `createFoldRunner` boundaries; the fakes are the compactor and the summarizer seam only.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SpanEstimator } from '../host/domain/estimate.js'
import { implicitTurnSpan } from '../host/domain/planner.js'
import { defaults } from '../host/domain/settings.js'
import { createFoldRunner } from '../host/runtime/scheduler.js'
import { Sim } from './fixtures/sim.js'
import { at, fakeMeter, harnessOf, sessionOf } from './fixtures/tools.js'

/** A summary long enough to be usable (docs/03 §6.2). */
const SUMMARY = `## Done\n${'Summarized the work with its changed paths and the reason for each choice. '.repeat(3)}`

/**
 * Open a turn the way the host log does: `turn/start` before the first surface node of the turn.
 *
 * @param {Sim} sim
 * @param {number} [turn]
 */
function turnStart(sim, turn = 1) {
  return sim.push({ type: 'turn/start', data: { turn } })
}

/**
 * A turn with a request and `batches` work batches (two surface nodes each) after it.
 *
 * @param {Sim} sim
 * @param {number} [batches]
 */
function turnOfWork(sim, batches = 2) {
  turnStart(sim)
  const first = sim.user('a request that starts the turn')
  sim.work(batches)
  return first
}

/** @param {Sim} sim */
function agentOf(sim) {
  return { session: sessionOf(sim), options: { provider: 'route-provider', model: 'route-model' } }
}

/** Let the runner's deferred microtasks run; no timer is involved. */
async function flushMicrotasks() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

/**
 * A compaction port stand-in: a successful fold replaces the region in the simulated session, the
 * way the host's transaction replaces the surface.
 *
 * @param {Sim} sim
 */
function foldEngine(sim) {
  /** @type {{ calls: any[], rejects: any[] }} */
  const record = { calls: [], rejects: [] }
  return {
    ...record,
    get calls() {
      return record.calls
    },
    get rejects() {
      return record.rejects
    },
    /** @param {any} request */
    async fold(request) {
      record.calls.push(request)
      sim.compact(request.region.startSeq, request.region.endSeq)
      return { start: request.region.startSeq, end: request.region.endSeq }
    },
    /** @param {any} request */
    async reject(request) {
      record.rejects.push(request)
      throw new Error('the implicit fold never records a failed attempt')
    },
    balancedBefore: () => true,
    balancedAfter: () => true,
    /** @param {unknown} _error @returns {'busy' | 'summary' | 'other'} */
    classify: (_error) => 'other',
  }
}

/**
 * A summarizer seam whose generations the test settles explicitly, so phase 1 is observable while
 * the generation is still running and without a timer.
 *
 * @param {{ supports?: () => boolean }} [options]
 */
function delegateSeam(options = {}) {
  /** @type {{ agent: any, target: any, region: any, signal: AbortSignal | undefined, nodes: readonly number[] }[]} */
  const starts = []
  /** @type {{ resolve: (result: any) => void, reject: (error: unknown) => void }[]} */
  const settle = []
  let supportCalls = 0
  return {
    delegate: {
      supports() {
        supportCalls += 1
        return options.supports === undefined ? true : options.supports()
      },
      /**
       * @param {any} agent
       * @param {any} target
       * @param {any} region
       * @param {AbortSignal | undefined} signal
       */
      start(agent, target, region, signal) {
        starts.push({ agent, target, region, signal, nodes: agent.session.surface.nodes.slice() })
        return new Promise((resolve, reject) => settle.push({ resolve, reject }))
      },
    },
    starts,
    supportCalls: () => supportCalls,
    /** @param {number} index @param {any} result */
    resolve(index, result) {
      at(settle, index).resolve(result)
    },
    /** @param {number} index @param {unknown} error */
    reject(index, error) {
      at(settle, index).reject(error)
    },
  }
}

/**
 * @param {Sim} sim
 * @param {{ engine?: any, settings?: object, noDelegate?: boolean, seam?: any }} [options]
 */
function runnerOf(sim, options = {}) {
  /** @type {string[]} */
  const logs = []
  const engine = options.engine ?? foldEngine(sim)
  const estimator = new SpanEstimator(fakeMeter())
  const seam = options.seam !== undefined ? options.seam : options.noDelegate === true ? null : delegateSeam()
  const runner = createFoldRunner({
    stateOf: async () => sim.state,
    engine: async () => engine,
    estimator,
    logger: {
      /** @param {string} message */
      warn: (message) => logs.push(message),
      /** @param {string} message */
      info: (message) => logs.push(message),
    },
    now: () => 0,
    ...(seam === null ? {} : { delegate: seam.delegate }),
    ...(options.settings === undefined
      ? {}
      : { settings: () => /** @type {any} */ ({ ...defaults(), ...options.settings }) }),
  })
  return { runner, logs, engine, seam }
}

/**
 * Run the pre-step boundary and hand back the host's own decision unchanged.
 *
 * @param {any} runner
 * @param {any} agent
 * @param {number} [turn]
 */
async function preStep(runner, agent, turn = 2) {
  const decision = { kind: 'enter', messages: [] }
  const returned = await runner.preStep({ agent, turn, step: 1, signal: undefined }, async () => decision)
  assert.equal(returned, decision)
  return returned
}

/** No compaction transaction of any kind was written. */
function assertNoCompaction(/** @type {Sim} */ sim) {
  assert.equal(
    sim.events.some((event) => event.type === 'compaction/summary'),
    false,
    'no summary was written',
  )
  assert.equal(
    sim.events.some((event) => event.type === 'compaction/start'),
    false,
    'no compaction transaction was opened',
  )
}

// ---------------------------------------------------------------------------
// The happy path: generate background, commit at a later boundary, no task meta

test('a turn that ended without a fold is summarized on its behalf and committed as a compaction', async () => {
  const sim = new Sim()
  turnOfWork(sim, 2)
  const agent = agentOf(sim)
  const { runner, logs, engine, seam } = runnerOf(sim)
  assert.equal(sim.state.turnStartSeq, at(sim.nodes, 1), 'the turn starts at the request')

  await runner.turnStopping({ agent, turn: 1, signal: undefined })
  assert.equal(seam.starts.length, 1, 'one background generation started')
  const start = at(seam.starts, 0)
  assert.equal(start.target.id, null, 'the implicit fold has no task')
  assert.equal(start.region.start, at(sim.nodes, 1), 'the span starts at the first node after the boundary')
  assert.equal(start.region.end, at(sim.nodes, sim.nodes.length - 1))
  assert.equal(engine.calls.length, 0, 'generation never commits inside the pass that started it')
  assert.equal(sim.state.folds.length, 0)

  const blocks = [{ type: 'text', text: '## Done\nThe delegate wrote the turn summary.' }]
  const usage = { inputTokens: 12, outputTokens: 6 }
  seam.resolve(0, { blocks, usage })
  await flushMicrotasks()
  assert.equal(sim.state.folds.length, 0, 'a settled generation commits nothing by itself')

  await preStep(runner, agent, 2)
  assert.equal(engine.calls.length, 1, 'the next boundary committed the generated text')
  const call = at(engine.calls, 0)
  assert.deepEqual(call.blocks, blocks)
  assert.deepEqual(call.usage, usage, 'the provider accounting reaches the host row')
  assert.deepEqual(call.route, { provider: 'route-provider', model: 'route-model' })
  assert.equal(call.region.startSeq, start.region.start)
  assert.equal(call.region.endSeq, start.region.end)

  // Durable, exactly like the host's own auto compaction: a summary plus a replacement, and a fold
  // row the projection records with no task id (docs/03 §4.2).
  assert.equal(sim.state.folds.length, 1)
  const row = at(sim.state.folds, 0)
  assert.equal(row.taskId, null, 'the fold belongs to no task')
  assert.equal(typeof row.nodeSeq, 'number')
  assert.ok(
    sim.events.some((event) => event.type === 'compaction/summary'),
    'a summary was written',
  )
  const replacement = sim.events.find(
    (event) => event.type === 'user/message' && event.surfaceOp && typeof event.surfaceOp === 'object',
  )
  assert.ok(replacement, 'the turn span was replaced')
  assert.equal(
    sim.events.some(
      (event) => event.type === 'tool/result' && event.data?.meta?.tf === 1 && event.data.meta.op === 'end',
    ),
    false,
    'an implicit fold writes no task_end meta',
  )
  assert.deepEqual(logs, ['task-folding: fold committed for the turn source=delegate'])
  // The span moved after the replacement: the turn now starts at the fold node.
  assert.equal(sim.state.turnStartSeq, replacement.seq)
})

// ---------------------------------------------------------------------------
// Guardrail: never folds when a task is open

test('a turn with an open task is never folded on its own behalf', async () => {
  const sim = new Sim()
  turnStart(sim)
  sim.user('a request')
  sim.begin('work in progress')
  sim.work(2)
  const agent = agentOf(sim)
  const { runner, logs, engine, seam } = runnerOf(sim)

  await runner.turnStopping({ agent, turn: 1 })
  assert.equal(sim.state.open.length, 1, 'the task is open')
  assert.equal(seam.starts.length, 0)
  assert.equal(engine.calls.length, 0)
  assert.deepEqual(logs, [])
})

// ---------------------------------------------------------------------------
// Guardrail: never folds around a task that is still waiting for its own fold

test('a closed task waiting for its own fold blocks the turn fold', async () => {
  const sim = new Sim()
  turnStart(sim)
  const h = harnessOf(sim, { meter: fakeMeter() })
  await h.batch([{ name: 'task_begin', args: { title: 'small work' } }])
  sim.work(2)
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])
  assert.equal(sim.state.tasks.T1?.status, 'queued')

  const engine = foldEngine(sim)
  engine.fold = async (/** @type {any} */ request) => {
    engine.calls.push(request)
    throw new Error('summary is not smaller than the shadowed content')
  }
  engine.classify = () => 'summary'
  const agent = agentOf(sim)
  const { runner, seam } = runnerOf(sim, { engine })

  await runner.turnStopping({ agent, turn: 1 })
  assert.equal(engine.calls.length, 1, 'the task fold was attempted and refused')
  assert.equal(sim.state.tasks.T1?.status, 'queued', 'the task still owns the turn')
  assert.equal(seam.starts.length, 0, 'the turn is not folded around a waiting task')
})

// ---------------------------------------------------------------------------
// Guardrail: never folds the same turn twice

test('a second boundary at the same turn starts no second generation', async () => {
  const sim = new Sim()
  turnOfWork(sim, 3)
  const agent = agentOf(sim)
  const { runner, seam } = runnerOf(sim)

  await runner.turnStopping({ agent, turn: 1 })
  await runner.turnStopping({ agent, turn: 1 })
  assert.equal(seam.starts.length, 1, 'one generation per turn')

  seam.resolve(0, { blocks: [{ type: 'text', text: '## Done\nCommitted once.' }] })
  await flushMicrotasks()
  await preStep(runner, agent)
  assert.equal(sim.state.folds.length, 1)

  // The turn continues after the fold, so its span is large enough again; the turn keeps its
  // identity (`turnSeq`), so it is never folded a second time.
  sim.work(1)
  await runner.turnStopping({ agent, turn: 1 })
  assert.equal(seam.starts.length, 1, 'the same turn is not folded twice')
  assert.equal(sim.state.folds.length, 1)
})

test('after a fold the turn span starts at the replacement, and the next turn starts after it', async () => {
  const sim = new Sim()
  turnOfWork(sim, 2)
  const agent = agentOf(sim)
  const { runner, seam } = runnerOf(sim)

  await runner.turnStopping({ agent, turn: 1 })
  seam.resolve(0, { blocks: [{ type: 'text', text: '## Done\nTurn one.' }] })
  await flushMicrotasks()
  await preStep(runner, agent)
  const replacement = /** @type {{ seq: number }} */ (
    sim.events.find(
      (event) => event.type === 'user/message' && event.surfaceOp && typeof event.surfaceOp === 'object',
    )
  )
  assert.equal(sim.state.turnStartSeq, replacement.seq, 'the boundary moved to the replacement')

  // Turn two is a different turn; its span begins at its own first node, not at the fold node.
  const first = turnStart(sim, 2)
  const request = sim.user('the second request')
  sim.work(2)
  await runner.turnStopping({ agent, turn: 2 })
  assert.equal(seam.starts.length, 2)
  const second = at(seam.starts, 1)
  assert.equal(second.region.start, request, 'the new turn fold starts at its own request')
  assert.ok(second.region.start > replacement.seq)
  assert.equal(second.nodes.includes(replacement.seq), true, 'the old fold is before the span, not inside it')
  assert.ok(first < request)
})

// ---------------------------------------------------------------------------
// Guardrail: never folds a span below minSpanTokens / the setting is off

test('a turn below the fold floor produces no generation and no event', async () => {
  const sim = new Sim()
  turnStart(sim)
  sim.user('too small to fold')
  const agent = agentOf(sim)
  const { runner, logs, engine, seam } = runnerOf(sim)

  await runner.turnStopping({ agent, turn: 1 })
  assert.equal(seam.starts.length, 0)
  assert.equal(engine.calls.length, 0)
  assertNoCompaction(sim)
  assert.deepEqual(logs, [])
})

test('the same turn is folded once the floor it is measured against is lower', async () => {
  const sim = new Sim()
  turnStart(sim)
  sim.user('small but worth folding when the floor is low')
  const agent = agentOf(sim)
  const { runner, seam } = runnerOf(sim, { settings: { minSpanTokens: 500 } })

  await runner.turnStopping({ agent, turn: 1 })
  assert.equal(seam.starts.length, 1, 'the floor decides, and the host meter priced the span')
  assert.equal(seam.starts[0].region.start, at(sim.nodes, 1))
})

test('the setting turns the implicit fold off', async () => {
  const sim = new Sim()
  turnOfWork(sim, 2)
  const agent = agentOf(sim)
  const { runner, logs, seam } = runnerOf(sim, { settings: { implicitTurnFold: false } })

  await runner.turnStopping({ agent, turn: 1 })
  assert.equal(seam.starts.length, 0)
  assert.deepEqual(logs, [])
  assertNoCompaction(sim)
})

test('a turn with no surface node has no span to fold', async () => {
  const sim = new Sim()
  turnStart(sim)
  const agent = agentOf(sim)
  const { runner, logs, seam } = runnerOf(sim)

  await runner.turnStopping({ agent, turn: 1 })
  assert.equal(sim.state.turnStartSeq, null)
  assert.equal(seam.starts.length, 0)
  assert.deepEqual(logs, [])
  assertNoCompaction(sim)
})

test('a turn whose boundary was absorbed by another checkpoint has no span to fold', async () => {
  const sim = new Sim()
  turnStart(sim)
  sim.user('a request')
  sim.work(2)
  const agent = agentOf(sim)
  const { runner, logs, engine, seam } = runnerOf(sim)

  // A head checkpoint starts before the turn boundary and swallows the turn's first node: the
  // boundary no longer has a position, so the turn cannot be folded.
  sim.compact(0, at(sim.nodes, 1))
  assert.equal(sim.state.turnStartSeq, -1)

  await runner.turnStopping({ agent, turn: 1 })
  assert.equal(seam.starts.length, 0)
  assert.equal(engine.calls.length, 0)
  assert.deepEqual(logs, [])
})

// ---------------------------------------------------------------------------
// Guardrail: never runs without the delegate

test('without the delegate seam nothing is generated and nothing is logged', async () => {
  const sim = new Sim()
  turnOfWork(sim, 2)
  const agent = agentOf(sim)
  const { runner, logs, engine } = runnerOf(sim, { noDelegate: true })

  await runner.turnStopping({ agent, turn: 1 })
  await runner.turnStopping({ agent, turn: 1 })
  assert.equal(engine.calls.length, 0)
  assert.deepEqual(logs, [])
  assertNoCompaction(sim)
})

test('a summarizer that reports itself unavailable starts nothing, and is probed once', async () => {
  const sim = new Sim()
  turnOfWork(sim, 2)
  const agent = agentOf(sim)
  const seam = delegateSeam({ supports: () => false })
  const { runner, logs, engine } = runnerOf(sim, { seam })

  await runner.turnStopping({ agent, turn: 1 })
  await runner.turnStopping({ agent, turn: 1 })
  assert.equal(seam.starts.length, 0)
  assert.equal(engine.calls.length, 0)
  assert.equal(seam.supportCalls(), 1, 'the capability is probed once per process')
  assert.deepEqual(logs, [])
})

// ---------------------------------------------------------------------------
// Guardrail: a moved surface drops the generated text; an aborted turn leaves no failure record

test('a span that moved while its summary was generated is dropped, not recorded as a failure', async () => {
  const sim = new Sim()
  turnOfWork(sim, 2)
  const agent = agentOf(sim)
  const { runner, logs, engine, seam } = runnerOf(sim)

  await runner.turnStopping({ agent, turn: 1 })
  assert.equal(seam.starts.length, 1)
  const span = at(seam.starts, 0).region

  // Another compaction swallows the turn's first node while the summary is generated: the span
  // the text was written for no longer exists.
  sim.compact(span.start, span.start)

  seam.resolve(0, { blocks: [{ type: 'text', text: '## Done\nStale.' }] })
  await flushMicrotasks()
  await preStep(runner, agent)

  assert.equal(engine.calls.length, 0, 'the stale text never reached the engine')
  assert.deepEqual(engine.rejects, [], 'nothing was recorded as a failed attempt')
  assert.equal(
    sim.events.some((event) => event.type === 'compaction/end' && event.data?.error !== undefined),
    false,
    'the implicit fold has no durable failure accounting',
  )
  assert.equal(
    logs.filter((line) => line.includes('turn summary is dropped')).length,
    1,
    'one line explains the drop',
  )
})

test('a replacement inside the span with unchanged edges drops the generated text', async () => {
  const sim = new Sim()
  turnOfWork(sim, 2)
  const agent = agentOf(sim)
  const { runner, logs, engine, seam } = runnerOf(sim)

  await runner.turnStopping({ agent, turn: 1 })
  // The pruner replaces one result inside the span: both edges and every position stay, so only
  // the region key can notice that the text no longer describes these nodes.
  sim.prune(at(sim.nodes, 3))

  seam.resolve(0, { blocks: [{ type: 'text', text: '## Done\nStale inside the span.' }] })
  await flushMicrotasks()
  await preStep(runner, agent)

  assert.equal(engine.calls.length, 0)
  assert.deepEqual(engine.rejects, [])
  assert.equal(
    logs.filter((line) => line.includes('the span changed while its summary was generated')).length,
    1,
  )
})

test('an unbalanced turn span is dropped before it reaches the engine', async () => {
  const sim = new Sim()
  turnOfWork(sim, 2)
  const agent = agentOf(sim)
  const engine = foldEngine(sim)
  const { runner, logs, seam } = runnerOf(sim, { engine })

  await runner.turnStopping({ agent, turn: 1 })
  assert.equal(seam.starts.length, 1)
  engine.balancedBefore = () => false

  seam.resolve(0, { blocks: [{ type: 'text', text: '## Done\nUnbalanced.' }] })
  await flushMicrotasks()
  await preStep(runner, agent)

  assert.equal(engine.calls.length, 0)
  assert.deepEqual(engine.rejects, [])
  assert.equal(logs.filter((line) => line.includes('the span is not tool-pairing balanced')).length, 1)
})

test('an aborted turn drops its generated text without a failure record or a retry', async () => {
  const sim = new Sim()
  turnOfWork(sim, 2)
  const agent = agentOf(sim)
  const controller = new AbortController()
  const { runner, logs, engine, seam } = runnerOf(sim)

  await runner.turnStopping({ agent, turn: 1, signal: controller.signal })
  assert.equal(seam.starts.length, 1)
  controller.abort()
  seam.reject(0, new Error('the turn was cancelled'))
  await flushMicrotasks()

  await preStep(runner, agent)
  assert.equal(engine.calls.length, 0)
  assert.deepEqual(engine.rejects, [])
  assert.equal(
    sim.events.some((event) => event.type === 'compaction/end'),
    false,
    'a cancellation writes no compaction rows',
  )
  assert.equal(logs.length, 1)
  assert.match(logs[0] ?? '', /cancelled with the turn/)

  // The turn's attempt is spent: an interruption is not a reason to bill the same turn twice.
  await runner.turnStopping({ agent, turn: 1 })
  assert.equal(seam.starts.length, 1)
})

// ---------------------------------------------------------------------------
// Commit policy

test('a generation that yields no usable summary leaves the turn unfolded, with no failure row', async () => {
  const sim = new Sim()
  turnOfWork(sim, 2)
  const agent = agentOf(sim)
  const { runner, logs, engine, seam } = runnerOf(sim)

  await runner.turnStopping({ agent, turn: 1 })
  seam.resolve(0, null)
  await flushMicrotasks()
  await preStep(runner, agent)

  assert.equal(engine.calls.length, 0)
  assert.deepEqual(engine.rejects, [], 'no durable failed attempt is written for a turn')
  assert.equal(sim.state.folds.length, 0)
  assert.equal(logs.length, 1)
  assert.match(logs[0] ?? '', /no usable summary for the turn/)

  await runner.turnStopping({ agent, turn: 1 })
  assert.equal(seam.starts.length, 1, 'the turn is not retried')
})

test('a turn span that is not tool-pairing balanced starts no generation', async () => {
  const sim = new Sim()
  turnOfWork(sim, 2)
  const agent = agentOf(sim)
  const engine = foldEngine(sim)
  engine.balancedBefore = () => false
  const { runner, logs, seam } = runnerOf(sim, { engine })

  await runner.turnStopping({ agent, turn: 1 })
  assert.equal(seam.starts.length, 0, 'a region the host would refuse is never generated for')
  assert.deepEqual(logs, [], 'the delegate task path is equally silent about it')
})

test('an unexpected commit failure drops the text without a durable failure row', async () => {
  const sim = new Sim()
  turnOfWork(sim, 2)
  const agent = agentOf(sim)
  const engine = foldEngine(sim)
  engine.fold = async (/** @type {any} */ request) => {
    engine.calls.push(request)
    throw new Error('the host transaction failed')
  }
  const { runner, logs, seam } = runnerOf(sim, { engine })

  await runner.turnStopping({ agent, turn: 1 })
  seam.resolve(0, { blocks: [{ type: 'text', text: '## Done\nNever committed.' }] })
  await flushMicrotasks()
  await preStep(runner, agent)

  assert.equal(engine.calls.length, 1)
  assert.deepEqual(engine.rejects, [])
  assert.equal(sim.state.folds.length, 0)
  assert.equal(
    sim.events.some((event) => event.type === 'compaction/end'),
    false,
    'no compaction rows, so no durable failure',
  )
  assert.equal(logs.filter((line) => line.includes('turn summary is dropped')).length, 1)
})

test('a busy lock keeps the generated text for the next boundary', async () => {
  const sim = new Sim()
  turnOfWork(sim, 2)
  const agent = agentOf(sim)
  const engine = foldEngine(sim)
  const fold = engine.fold
  let busy = true
  engine.fold = async (/** @type {any} */ request) => {
    if (busy) {
      busy = false
      throw new Error('busy')
    }
    return fold(request)
  }
  engine.classify = (/** @type {unknown} */ error) =>
    error instanceof Error && error.message === 'busy' ? 'busy' : 'other'
  const { runner, seam } = runnerOf(sim, { engine })

  await runner.turnStopping({ agent, turn: 1 })
  seam.resolve(0, { blocks: [{ type: 'text', text: '## Done\nKept for the retry.' }] })
  await flushMicrotasks()

  await preStep(runner, agent)
  assert.equal(engine.calls.length, 0, 'the busy attempt wrote nothing')
  assert.equal(sim.state.folds.length, 0)

  await preStep(runner, agent)
  assert.equal(engine.calls.length, 1, 'the next boundary committed the kept text')
  assert.equal(sim.state.folds.length, 1)
  assert.equal(at(sim.state.folds, 0).taskId, null)
})

test('a turn that starts at the very first surface node is still foldable', () => {
  // `turnStartSeq` is a seq, and the host numbers events from zero: a boundary at 0 is a real
  // position, not "absent" (a mutant `start < 0 -> start < 1` would refuse this turn).
  const sim = new Sim()
  turnStart(sim)
  const first = /** @type {number} */ (sim.nodes[0])
  assert.equal(typeof first, 'number')
  const state = { ...sim.state, turnStartSeq: 0, turnFolded: false }
  const settings = { ...defaults(), minSpanTokens: 0 }
  const span = implicitTurnSpan(state, sessionOf(sim), settings, new SpanEstimator(fakeMeter()))
  assert.deepEqual(span, { startSeq: 0, endSeq: sim.nodes.at(-1) })
})

test('a boundary that is not on the surface has no span', () => {
  const sim = new Sim()
  const state = { ...sim.state, turnStartSeq: 999_999, turnFolded: false }
  assert.equal(
    implicitTurnSpan(
      state,
      sessionOf(sim),
      { ...defaults(), minSpanTokens: 0 },
      new SpanEstimator(fakeMeter()),
    ),
    null,
  )
})

test('a turn that starts at the last node has a one-node span, not none', () => {
  const sim = new Sim()
  const last = /** @type {number} */ (sim.nodes.at(-1))
  assert.equal(typeof last, 'number')
  const state = { ...sim.state, turnStartSeq: last, turnFolded: false }
  const settings = { ...defaults(), minSpanTokens: 0 }
  assert.deepEqual(implicitTurnSpan(state, sessionOf(sim), settings, new SpanEstimator(fakeMeter())), {
    startSeq: last,
    endSeq: last,
  })
})

test('a turn whose span is exactly at the floor is still folded', () => {
  // `tokens < floor` must be strict: equality folds (a mutant `<=` would refuse the boundary).
  const sim = new Sim()
  turnStart(sim)
  const first = sim.user('turn request')
  assert.equal(typeof first, 'number')
  sim.work(2)
  const state = { ...sim.state, turnStartSeq: /** @type {number} */ (first), turnFolded: false }
  const estimator = new SpanEstimator(fakeMeter())
  const nodes = sessionOf(sim).surface.nodes
  const startIndex = nodes.indexOf(first)
  const tokens = estimator.regionTokens(sessionOf(sim), nodes, startIndex, nodes.length - 1)
  const settings = { ...defaults(), minSpanTokens: tokens }
  assert.deepEqual(implicitTurnSpan(state, sessionOf(sim), settings, estimator), {
    startSeq: first,
    endSeq: nodes.at(-1),
  })
})
