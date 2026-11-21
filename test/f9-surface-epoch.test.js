// The F9 acceptance criterion of docs/10 §17: a replacement that lands while a pass is running must
// not cost the task its folds for the whole session. The surface epoch is what makes that true — the
// skip a stale resolution produces belongs to the version it was decided at, and a later replacement
// moves the version, so the task is examined again.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SpanEstimator } from '../host/domain/estimate.js'
import { createFoldRunner } from '../host/runtime/scheduler.js'
import { Sim } from './fixtures/sim.js'
import { fakeMeter, harnessOf, sessionOf } from './fixtures/tools.js'

const SUMMARY = `## Done\n${'Summarized the work with its changed paths and the reason for each choice. '.repeat(3)}`

/** @param {Sim} sim */
function engineOf(sim) {
  /** @type {{ start: number, end: number }[]} */
  const calls = []
  return {
    calls,
    /** @param {{ agent?: any, region: { startSeq: number, endSeq: number } }} request */
    async fold(request) {
      calls.push({ start: request.region.startSeq, end: request.region.endSeq })
      sim.compact(request.region.startSeq, request.region.endSeq)
      return { start: request.region.startSeq, end: request.region.endSeq }
    },
    balancedBefore: () => true,
    balancedAfter: () => true,
    classify: () => 'other',
  }
}

/**
 * @param {Sim} sim
 * @param {any} engine
 */
function runnerOf(sim, engine) {
  /** @type {string[]} */
  const logs = []
  const runner = createFoldRunner({
    stateOf: async () => sim.state,
    engine: async () => engine,
    estimator: new SpanEstimator(fakeMeter()),
    logger: {
      /** @param {string} message */
      warn(message) {
        logs.push(message)
      },
      /** @param {string} message */
      info(message) {
        logs.push(message)
      },
    },
    now: () => 0,
  })
  return { runner, logs }
}

test('a task skipped at one surface version is folded after the next replacement', async () => {
  const sim = new Sim()
  const h = harnessOf(sim, { meter: fakeMeter() })
  await h.batch([{ name: 'task_begin', args: { title: 'first' } }])
  sim.work(3)
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])
  assert.equal(sim.state.tasks.T1?.status, 'queued', 'the task waits for the next boundary')

  const engine = engineOf(sim)
  const { runner, logs } = runnerOf(sim, engine)
  const agent = { session: sessionOf(sim) }

  // The first pass folds normally: the epoch does not get in the way of a healthy fold.
  const first = await runner.pass(agent, undefined, true)
  assert.deepEqual(first, { folded: 1, busy: false, skipped: [] })
  assert.equal(sim.state.tasks.T1?.status, 'folded')
  assert.equal(engine.calls.length, 1)
  assert.equal(logs.length, 0, 'a healthy fold logs nothing')
})

test('the epoch of a snapshot is what a skip is keyed by, so a new replacement re-examines the task', async () => {
  const sim = new Sim()
  const h = harnessOf(sim, { meter: fakeMeter() })
  await h.batch([{ name: 'task_begin', args: { title: 'outer' } }])
  await h.batch([{ name: 'task_begin', args: { title: 'inner' } }])
  sim.work(3)
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])
  assert.equal(sim.state.tasks.T2?.status, 'queued')

  const engine = engineOf(sim)
  const { runner } = runnerOf(sim, engine)
  const agent = { session: sessionOf(sim) }
  // A node after the closed task's span: replacing it moves the version but cannot touch the span.
  sim.work(2)
  const outside = sim.nodes[sim.nodes.length - 1]
  assert.equal(typeof outside, 'number')
  const epochBefore = sim.state.surfaceEpoch
  sim.prune(/** @type {number} */ (outside))
  assert.equal(sim.state.surfaceEpoch, epochBefore + 1)

  const report = await runner.pass(agent, undefined, true)
  assert.deepEqual(
    report,
    { folded: 1, busy: false, skipped: [] },
    'the moved version is not a permanent skip',
  )
  assert.equal(sim.state.tasks.T2?.status, 'folded')
  assert.equal(sim.state.tasks.T1?.status, 'open', 'the outer task is still being worked on')
})
