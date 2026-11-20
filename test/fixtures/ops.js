// Random session programs for property and replay tests: operations a model and the host can
// perform, and the invariants of docs/03-architecture.md §12 checked after each one.

import assert from 'node:assert/strict'

import fc from 'fast-check'

import { dueTasks, resolveRegion } from '../../host/planner.js'
import { TERMINAL, WAITING } from '../../host/projection.js'
/** @typedef {import('./sim.js').Sim} Sim */

/** @typedef {import('../../host/types.js').TaskStatus} TaskStatus */

const verdict = fc.constantFrom(
  /** @type {const} */ ('queued'),
  'queued',
  'queued',
  'delegate',
  'below-floor',
)

export const opArb = fc.oneof(
  { weight: 4, arbitrary: fc.record({ t: fc.constant('begin') }) },
  { weight: 4, arbitrary: fc.record({ t: fc.constant('end'), verdict }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('endOuter'), verdict }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('relay'), verdict }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('doubleBegin') }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('beginEnd') }) },
  {
    weight: 6,
    arbitrary: fc.record({
      t: fc.constant('work'),
      n: fc.integer({ min: 1, max: 3 }),
      calls: fc.integer({ min: 1, max: 3 }),
    }),
  },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('say') }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('fold') }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('compactHead'), n: fc.integer({ min: 2, max: 30 }) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('prune'), back: fc.integer({ min: 0, max: 12 }) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('interrupted'), begin: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('fail') }) },
)

/**
 * @param {Sim} sim
 * @param {any} op
 */
export function run(sim, op) {
  switch (op.t) {
    case 'begin':
      return sim.begin()
    case 'end':
      return sim.end({ verdict: op.verdict })
    case 'endOuter':
      return sim.end({
        ...(sim.state.open[0] === undefined ? {} : { id: sim.state.open[0] }),
        verdict: op.verdict,
      })
    case 'relay':
      return sim.batch([{ kind: 'end', verdict: op.verdict }, { kind: 'begin' }])
    case 'doubleBegin':
      return sim.batch([{ kind: 'begin' }, { kind: 'other' }, { kind: 'begin' }])
    case 'beginEnd':
      return sim.batch([{ kind: 'begin' }, { kind: 'other' }, { kind: 'end' }])
    case 'work':
      for (let i = 0; i < op.n; i++)
        sim.batch(Array.from({ length: op.calls }, () => ({ kind: /** @type {const} */ ('other') })))
      return
    case 'say':
      return sim.say()
    case 'fold':
      for (const task of dueTasks(sim.state)) {
        const current = sim.state.tasks[task.id]
        if (current && WAITING.has(current.status) && resolveRegion(current, sim.nodes).kind === 'fold')
          sim.fold(task.id)
      }
      return
    case 'compactHead':
      return sim.compactHead(op.n)
    case 'prune': {
      const results = sim.nodes.filter((seq) => sim.bySeq.get(seq)?.type === 'tool/result')
      const seq = results[results.length - 1 - op.back]
      if (seq !== undefined) sim.prune(seq)
      return
    }
    case 'interrupted':
      // An interrupted step as the host leaves it: unanswered calls closed by session repair.
      return sim.batch([op.begin ? { kind: 'begin' } : { kind: 'other' }, { kind: 'other' }], {
        drop: 1,
        repair: true,
      })
    case 'fail':
      return sim.failCompaction()
  }
}

/**
 * @param {Sim} sim
 * @param {Map<string, TaskStatus>} terminal
 */
export function checkInvariants(sim, terminal) {
  const { state } = sim
  /** @type {[number, number, string][]} */
  const ranges = []
  for (const id of state.order) {
    const task = /** @type {import('../../host/types.js').Task} */ (state.tasks[id])
    // 4: a terminal verdict never changes
    const seen = terminal.get(id)
    if (seen !== undefined) assert.equal(task.status, seen, `${id} left terminal status ${seen}`)
    else if (TERMINAL.has(task.status)) terminal.set(id, task.status)

    if (!WAITING.has(task.status)) continue
    const region = resolveRegion(task, sim.nodes)
    assert.notEqual(
      region.kind,
      'inconsistent',
      `${id}: ${region.kind === 'inconsistent' ? region.reason : ''}`,
    )
    assert.notEqual(region.kind, 'absorbed', `${id}: absorbed tasks must not stay waiting`)
    if (region.kind !== 'fold') continue
    // 1: balanced
    assert.ok(sim.balancedRange(region.startIndex, region.endIndex), `${id} region is unbalanced`)
    ranges.push([region.startIndex, region.endIndex, id])
  }
  // 2: disjoint or nested
  for (const [a0, a1, a] of ranges) {
    for (const [b0, b1, b] of ranges) {
      if (a === b) continue
      const disjoint = a1 < b0 || b1 < a0
      const nested = (a0 <= b0 && b1 <= a1) || (b0 <= a0 && a1 <= b1)
      assert.ok(disjoint || nested, `${a} and ${b} partially overlap`)
    }
  }
  // open stack = tasks still opening or open, in begin order
  const live = state.order.filter((id) => {
    const status = state.tasks[id]?.status
    return status === 'open' || status === 'opening'
  })
  assert.deepEqual(state.open, live)
}
