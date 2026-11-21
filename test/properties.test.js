// Invariants 1, 2, 4 and the open-stack invariant of docs/03-architecture.md §12 over random
// sessions. Replay equivalence (invariant 3) is in replay.test.js.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import fc from 'fast-check'

import { checkInvariants, opArb, run } from './fixtures/ops.js'
import { Sim } from './fixtures/sim.js'

/** @typedef {import('../host/domain/types.js').TaskStatus} TaskStatus */

test('random sessions keep regions balanced, non-overlapping, and verdicts final', () => {
  fc.assert(
    fc.property(fc.array(opArb, { minLength: 5, maxLength: 60 }), (ops) => {
      const sim = new Sim()
      sim.user()
      /** @type {Map<string, TaskStatus>} */
      const terminal = new Map()
      for (const op of ops) {
        run(sim, op)
        checkInvariants(sim, terminal)
      }
      // Close everything and fold what is left: every waiting task must fold cleanly.
      while (sim.state.open.length > 0) sim.end()
      sim.say()
      run(sim, { t: 'fold' })
      checkInvariants(sim, terminal)
      for (const id of sim.state.order) {
        assert.ok(sim.state.tasks[id]?.status !== 'queued', `${id} still queued after the final fold`)
      }
    }),
    { numRuns: 1000 },
  )
})
