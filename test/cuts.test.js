import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ABSORBED, isAbsorbed, translateAfter, translateFirst, translateTask } from '../host/cuts.js'

/** @type {import('../host/types.js').ReplaceOp} */
const op = { op: 'replace', startSeq: 10, endSeq: 20 }
const shadowed = new Set([10, 12, 15, 20])
const R = 30

test('translateAfter keeps untouched, unknown and absorbed boundaries', () => {
  assert.equal(translateAfter(null, shadowed, op, R), null)
  assert.equal(translateAfter(ABSORBED, shadowed, op, R), ABSORBED)
  assert.equal(translateAfter(9, shadowed, op, R), 9)
})

test('translateAfter moves a boundary after the last shadowed node and absorbs the rest', () => {
  assert.equal(translateAfter(20, shadowed, op, R), R)
  assert.equal(translateAfter(15, shadowed, op, R), ABSORBED)
  assert.equal(translateAfter(10, shadowed, op, R), ABSORBED)
})

test('translateFirst keeps untouched, unknown and absorbed span starts', () => {
  assert.equal(translateFirst(null, shadowed, op, R), null)
  assert.equal(translateFirst(ABSORBED, shadowed, op, R), ABSORBED)
  assert.equal(translateFirst(21, shadowed, op, R), 21)
})

test('translateFirst moves a span start that the replacement starts at and absorbs the rest', () => {
  assert.equal(translateFirst(10, shadowed, op, R), R)
  assert.equal(translateFirst(12, shadowed, op, R), ABSORBED)
})

/** @returns {import('../host/types.js').Task} */
function task(/** @type {Partial<import('../host/types.js').Task>} */ fields) {
  return {
    id: 'T1',
    title: 't',
    parent: null,
    depth: 0,
    status: 'open',
    beginCut: 5,
    spanStart: 6,
    endCut: null,
    endMsgSeq: null,
    endCallId: null,
    verdict: null,
    outcome: null,
    estTokens: -1,
    summaryChars: 0,
    openedAt: 0,
    reported: false,
    failures: 0,
    foldIndex: null,
    ...fields,
  }
}

test('translateTask returns the same object when nothing moves', () => {
  const t = task({})
  assert.equal(translateTask(t, shadowed, op, R), t)
})

test('translateTask moves each boundary independently', () => {
  const t = task({ beginCut: 4, spanStart: 10, endCut: 20 })
  const moved = translateTask(t, shadowed, op, R)
  assert.notEqual(moved, t)
  assert.deepEqual([moved.beginCut, moved.spanStart, moved.endCut], [4, R, R])
})

test('isAbsorbed is true when any boundary is absorbed', () => {
  assert.equal(isAbsorbed(task({})), false)
  assert.equal(isAbsorbed(task({ beginCut: ABSORBED })), true)
  assert.equal(isAbsorbed(task({ spanStart: ABSORBED })), true)
  assert.equal(isAbsorbed(task({ endCut: ABSORBED })), true)
})
