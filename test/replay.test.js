// Invariant 3 (docs/03-architecture.md §12): replaying from any JSON checkpoint gives the same
// state as replaying the whole log. Also replays the real M0 journals.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import fc from 'fast-check'

import { apply, initialState, parseState } from '../host/projection.js'
import { journalNames, loadJournal } from './fixtures/journals.js'
import { Sim } from './fixtures/sim.js'
import { opArb, run } from './fixtures/ops.js'

/** @typedef {import('../host/types.js').SessionEvent} SessionEvent */
/** @typedef {import('../host/types.js').State} State */

/**
 * @param {readonly SessionEvent[]} events
 * @param {State} [from]
 */
function replay(events, from = initialState()) {
  return events.reduce(apply, from)
}

/** @param {State} state */
function checkpoint(state) {
  return parseState(JSON.parse(JSON.stringify(state)))
}

/**
 * @param {readonly SessionEvent[]} events
 * @param {number[]} positions
 */
function assertReplayEquivalent(events, positions) {
  const full = replay(events)
  for (const k of positions) {
    const resumed = replay(events.slice(k), checkpoint(replay(events.slice(0, k))))
    assert.deepEqual(resumed, full, `resume at event ${k}`)
  }
}

test('generated sessions: resuming from a checkpoint at every position equals a full replay', () => {
  fc.assert(
    fc.property(fc.array(opArb, { minLength: 5, maxLength: 30 }), (ops) => {
      const sim = new Sim()
      sim.user()
      for (const op of ops) run(sim, op)
      assert.deepEqual(replay(sim.events), sim.state)
      assertReplayEquivalent(
        sim.events,
        sim.events.map((_, i) => i),
      )
    }),
    { numRuns: 150 },
  )
})

test('M0 journals replay without errors and record every compaction', () => {
  const names = journalNames()
  assert.ok(names.length >= 8, 'the M0 journals are present')
  for (const name of names) {
    const events = loadJournal(name)
    const state = replay(events)
    const summaries = events.filter((e) => e.type === 'compaction/summary')
    assert.equal(state.folds.length, summaries.length, `${name}: one fold row per compaction/summary`)
    for (const row of state.folds)
      assert.equal(typeof row.nodeSeq, 'number', `${name}: replacement seen for ${row.summarySeq}`)
    assert.equal(state.pendingSummary, null, name)
    assert.deepEqual(state.order, [], `${name}: no task-mark meta in the probe sessions`)
    const headers = events.filter((e) => e.type === 'request/header')
    assert.equal(state.lastHeaderSeq, headers.length > 0 ? headers[headers.length - 1]?.seq : null, name)
    const step = Math.max(1, Math.floor(events.length / 25))
    assertReplayEquivalent(
      events,
      events.map((_, i) => i).filter((i) => i % step === 0),
    )
  }
})

test('M0 journals: ignored events return the same state reference', () => {
  const events = loadJournal('S2.jsonl')
  let state = initialState()
  const changing = new Set([
    'assistant/message',
    'tool/result',
    'user/message',
    'system/message',
    'step/end',
    'request/header',
    'compaction/summary',
  ])
  for (const event of events) {
    const next = apply(state, event)
    if (!changing.has(event.type)) assert.equal(next, state, `${event.type} changed the state`)
    state = next
  }
})
