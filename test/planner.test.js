import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ABSORBED } from '../host/cuts.js'
import { dueTasks, resolveRegion } from '../host/planner.js'
import { initialState } from '../host/projection.js'

/** @typedef {import('../host/types.js').Task} Task */

/** @returns {Task} */
function task(/** @type {Partial<Task>} */ fields) {
  return {
    id: 'T1',
    title: 't',
    parent: null,
    depth: 0,
    status: 'queued',
    beginCut: 1,
    spanStart: 2,
    endCut: 4,
    endMsgSeq: 3,
    endCallId: 'c',
    verdict: 'queued',
    outcome: 'done',
    estTokens: 3000,
    summaryChars: 300,
    openedAt: 0,
    reported: true,
    failures: 0,
    foldIndex: null,
    ...fields,
  }
}

test('resolveRegion returns the inclusive positions of a valid span', () => {
  assert.deepEqual(resolveRegion(task({}), [0, 1, 2, 3, 4, 5]), {
    kind: 'fold',
    start: 2,
    end: 4,
    startIndex: 2,
    endIndex: 4,
  })
})

test('resolveRegion reports absorbed boundaries', () => {
  for (const field of /** @type {const} */ (['beginCut', 'spanStart', 'endCut'])) {
    assert.deepEqual(resolveRegion(task({ [field]: ABSORBED }), [0, 1, 2, 3, 4]), { kind: 'absorbed' })
  }
})

test('resolveRegion reports missing cuts, missing nodes and a detached span start', () => {
  assert.equal(resolveRegion(task({ beginCut: null }), [0, 1, 2]).kind, 'inconsistent')
  assert.equal(resolveRegion(task({ endCut: null }), [0, 1, 2]).kind, 'inconsistent')
  assert.equal(resolveRegion(task({}), [0, 1, 2, 3]).kind, 'inconsistent')
  assert.equal(resolveRegion(task({}), [0, 1, 9, 2, 3, 4]).kind, 'inconsistent')
})

test('resolveRegion reports an empty span', () => {
  assert.deepEqual(resolveRegion(task({ spanStart: null }), [0, 1, 2, 3, 4]), { kind: 'empty' })
  assert.deepEqual(resolveRegion(task({ beginCut: 3, spanStart: 4, endCut: 2 }), [0, 1, 2, 3, 4]), {
    kind: 'empty',
  })
})

test('dueTasks orders by depth, then close order, then creation order', () => {
  const state = initialState()
  state.order = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6']
  state.tasks = {
    T1: task({ id: 'T1', endMsgSeq: 50 }),
    T2: task({ id: 'T2', depth: 1, endMsgSeq: 40 }),
    T3: task({ id: 'T3', depth: 1, endMsgSeq: 30 }),
    T4: task({ id: 'T4', endMsgSeq: null, status: 'delegate' }),
    T5: task({ id: 'T5', endMsgSeq: null, status: 'delegate' }),
    T6: task({ id: 'T6', status: 'folded' }),
  }
  assert.deepEqual(
    dueTasks(state).map((t) => t.id),
    ['T3', 'T2', 'T1', 'T4', 'T5'],
  )
})

test('dueTasks waits for a report unless the turn is stopping, and skips missing rows', () => {
  const state = initialState()
  state.order = ['T1', 'T9']
  state.tasks = { T1: task({ reported: false }) }
  assert.deepEqual(dueTasks(state), [])
  assert.deepEqual(
    dueTasks(state, { turnStopping: true }).map((t) => t.id),
    ['T1'],
  )
})
