import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ABSORBED } from '../host/domain/cuts.js'
import { dueTasks, resolveRegion } from '../host/domain/planner.js'
import { initialState } from '../host/domain/projection.js'

/** @typedef {import('../host/domain/types.js').Task} Task */

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

test('resolveRegion reports each missing boundary node, not only all three', () => {
  // A partial miss is the dangerous case: with the three checks joined by `&&` the span would be
  // reported as foldable with an index of -1.
  assert.deepEqual(resolveRegion(task({ beginCut: 1, spanStart: 2, endCut: 4 }), [1, 2, 4]), {
    kind: 'fold',
    start: 2,
    end: 4,
    startIndex: 1,
    endIndex: 2,
  })
  // The begin cut at position 0 is a real cut, not "absent".
  assert.deepEqual(resolveRegion(task({ beginCut: 1, spanStart: 2, endCut: 4 }), [1, 2, 4]), {
    kind: 'fold',
    start: 2,
    end: 4,
    startIndex: 1,
    endIndex: 2,
  })
  // A span of one node (startIndex === endIndex) is foldable.
  assert.deepEqual(resolveRegion(task({ beginCut: 1, spanStart: 2, endCut: 2 }), [1, 2]), {
    kind: 'fold',
    start: 2,
    end: 2,
    startIndex: 1,
    endIndex: 1,
  })
})

test('dueTasks puts the deeper task first even when creation order disagrees', () => {
  const shallow = task({ id: 'T1', depth: 0, reported: true })
  const deep = task({ id: 'T2', parent: 'T1', depth: 1, reported: true })
  const state = {
    ...initialState(),
    order: ['T1', 'T2'],
    tasks: { T1: shallow, T2: deep },
    open: ['T1', 'T2'],
  }
  assert.deepEqual(
    dueTasks(state, { turnStopping: false }).map((entry) => entry.id),
    ['T2', 'T1'],
    'depth descends',
  )
})

test('resolveRegion accepts a span whose begin cut is the first surface node', () => {
  // `indexOf` returning 0 is a real position, not "absent" (a mutant `=== -1 -> === 0` refuses it).
  assert.deepEqual(resolveRegion(task({ beginCut: 7, spanStart: 8, endCut: 9 }), [7, 8, 9]), {
    kind: 'fold',
    start: 8,
    end: 9,
    startIndex: 1,
    endIndex: 2,
  })
  assert.deepEqual(resolveRegion(task({ beginCut: 7, spanStart: 8, endCut: 9 }), [0, 7, 8, 9]), {
    kind: 'fold',
    start: 8,
    end: 9,
    startIndex: 2,
    endIndex: 3,
  })
})

test('dueTasks orders by depth before close order, with a disagreement between them', () => {
  // `a - b -> a + b` in the comparator stays truthy for any pair and would fall through to the
  // next key; this pair makes the two keys disagree so the depth key has to win.
  const deepLate = task({ id: 'T1', depth: 2, endMsgSeq: 90, reported: true })
  const shallowEarly = task({ id: 'T2', depth: 0, endMsgSeq: 10, reported: true })
  const state = {
    ...initialState(),
    order: ['T2', 'T1'],
    tasks: { T1: deepLate, T2: shallowEarly },
    open: ['T1'],
  }
  assert.deepEqual(
    dueTasks(state, { turnStopping: false }).map((entry) => entry.id),
    ['T1', 'T2'],
    'the deeper task comes first even though the shallow one closed earlier',
  )
})
