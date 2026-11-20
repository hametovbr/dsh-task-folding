// Performance guard (docs/06-testing.md §4): the boundary cost must stay flat as the log grows.
// The session is synthetic, but the projection and the runner under test are the real ones.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SpanEstimator } from '../host/estimate.js'
import { createFoldRunner } from '../host/fold-runner.js'
import { Sim } from './fixtures/sim.js'
import { fakeMeter, harnessOf, sessionOf } from './fixtures/tools.js'

const BIG = { events: 80_000, tasks: 200 }
const SMALL = { events: 5_000, tasks: 200 }
const SUMMARY = `## Done\n${'Summarized the work with its changed paths and the reason for each choice. '.repeat(3)}`

/**
 * A log of roughly `events` events and `tasks` closed tasks, all of them `below-floor`, plus
 * (optionally) one large task that is `queued` at the end.
 *
 * @param {{ events: number, tasks: number, foldable?: boolean }} spec
 */
async function buildLog(spec) {
  const sim = new Sim()
  // One token per message keeps every small task under the fold floor.
  const h = harnessOf(sim, { meter: fakeMeter({ perMessage: 1 }) })
  for (let i = 0; i < spec.tasks && sim.events.length < spec.events; i += 1) {
    await h.batch([{ name: 'task_begin', args: { title: `task ${i}` } }])
    sim.work(1)
    await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])
  }
  while (sim.events.length < spec.events) sim.work(1)
  if (spec.foldable) {
    await h.batch([{ name: 'task_begin', args: { title: 'the big one' } }])
    sim.work(1_500)
    await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])
    // A model message after the close is what makes a task due outside turn-stopping.
    sim.say()
  }
  return { sim, session: sessionOf(sim) }
}

/**
 * @param {Sim} sim
 * @param {any} engine
 */
function runnerOver(sim, engine) {
  return createFoldRunner({
    stateOf: async () => sim.state,
    engine: async () => engine,
    estimator: new SpanEstimator(fakeMeter()),
    logger: { warn() {} },
  })
}

/** Records the call and changes nothing: the boundary cost, not the fake transaction, is measured. */
function recordingEngine() {
  /** @type {{ start: number, end: number }[]} */
  const calls = []
  return {
    calls,
    /** @param {any} _agent @param {number} start @param {number} end */
    async foldRegion(_agent, start, end) {
      calls.push({ start, end })
      return {}
    },
    balancedBefore: () => true,
    balancedAfter: () => true,
    classify: () => 'other',
  }
}

test('the synthetic log has the size and shape the guards assume', async () => {
  const { sim } = await buildLog(BIG)
  assert.ok(sim.events.length >= BIG.events, `${sim.events.length} events`)
  assert.equal(sim.state.order.length, BIG.tasks)
  assert.ok(sim.state.order.every((id) => sim.state.tasks[id]?.status === 'below-floor'))
  assert.deepEqual(sim.state.open, [])
})

test('a pre-step with nothing due stays under 2 ms at 80k events', async () => {
  const { sim, session } = await buildLog(BIG)
  const engine = recordingEngine()
  const runner = runnerOver(sim, engine)
  const agent = { session, options: {} }
  const start = performance.now()
  for (let i = 0; i < 20; i += 1) await runner.preStep({ agent, turn: 1, step: i }, async () => 'd')
  const perCall = (performance.now() - start) / 20
  assert.equal(engine.calls.length, 0, 'nothing was due')
  assert.ok(perCall < 2, `a pre-step with nothing due took ${perCall.toFixed(3)} ms`)
})

test('a pre-step with one due fold stays under 10 ms at 80k events', async () => {
  const { sim, session } = await buildLog({ ...BIG, foldable: true })
  const engine = recordingEngine()
  const runner = runnerOver(sim, engine)
  const agent = { session, options: {} }
  const due = sim.state.tasks.T201
  assert.equal(due?.status, 'queued', 'the big task is queued')
  // Warm the JIT and the per-seq estimate cache, as a real session is after a few steps, then
  // take the median of a handful of folding boundaries: the runner must not pay per-call setup.
  await runner.preStep({ agent, turn: 1, step: 0 }, async () => 'd')
  /** @type {number[]} */
  const timings = []
  for (let i = 1; i <= 5; i += 1) {
    const start = performance.now()
    await runner.preStep({ agent, turn: 1, step: i }, async () => 'd')
    timings.push(performance.now() - start)
  }
  const elapsed = median(timings)
  assert.equal(engine.calls.length >= 1, true, 'the due task reached the engine')
  assert.ok(
    elapsed < 10,
    `a folding boundary took ${elapsed.toFixed(3)} ms (all: ${timings.map((t) => t.toFixed(2)).join(', ')})`,
  )
})

test('the boundary cost does not grow with the log: 5k vs 80k stays under 2x', async () => {
  const small = await measure(SMALL)
  const big = await measure(BIG)
  const ratio = big / Math.max(small, 0.001)
  assert.ok(
    ratio < 2,
    `80k took ${big.toFixed(3)} ms, 5k took ${small.toFixed(3)} ms, ratio ${ratio.toFixed(2)}`,
  )
})

/**
 * @param {number[]} values
 * @returns {number}
 */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? Infinity
}

/**
 * The per-call cost of a pre-step with nothing due.
 *
 * @param {{ events: number, tasks: number }} spec
 */
async function measure(spec) {
  const { sim, session } = await buildLog(spec)
  const runner = runnerOver(sim, recordingEngine())
  const agent = { session, options: {} }
  // Warm up the first call so module-level work is not charged to the measurement.
  await runner.preStep({ agent, turn: 1, step: 0 }, async () => 'd')
  const start = performance.now()
  for (let i = 0; i < 10; i += 1) await runner.preStep({ agent, turn: 1, step: i }, async () => 'd')
  return (performance.now() - start) / 10
}
