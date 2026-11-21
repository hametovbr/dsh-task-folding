import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ABSORBED } from '../host/domain/cuts.js'
import { dueTasks, resolveRegion } from '../host/domain/planner.js'
import {
  apply,
  init,
  initialState,
  isBeginMeta,
  isEndMeta,
  MAX_DELEGATE_FAILURES,
  parseState,
  parseView,
  PROJECTION_KEY,
  RECENT_LIMIT,
  STATE_VERSION,
  stateSchema,
  viewSchema,
  toolCalls,
  view,
} from '../host/domain/projection.js'
import { Sim } from './fixtures/sim.js'

/** @typedef {import('../host/domain/types.js').Task} Task */

/** @param {Sim} sim @param {string} id @returns {Task} */
function task(sim, id) {
  const t = sim.state.tasks[id]
  assert.ok(t, `task ${id} exists`)
  return t
}

/** @param {Sim} sim @param {string} id */
function assertFoldableAndBalanced(sim, id) {
  const region = resolveRegion(task(sim, id), sim.nodes)
  assert.equal(region.kind, 'fold', `${id} resolves to a fold region`)
  if (region.kind !== 'fold') return
  assert.ok(sim.balancedRange(region.startIndex, region.endIndex), `${id} region is tool-pairing balanced`)
}

test('constants and init', () => {
  assert.equal(PROJECTION_KEY, 'taskFolding')
  assert.equal(STATE_VERSION, 1)
  assert.deepEqual(init({}, 0), initialState())
})

test('task_begin opens a task with its cut after the begin batch and its span at the next node', () => {
  const sim = new Sim()
  sim.user()
  const { seq: msg } = sim.begin('Fix login')
  const t1 = task(sim, 'T1')
  assert.equal(t1.status, 'open')
  assert.equal(t1.title, 'Fix login')
  assert.equal(t1.beginCut, msg + 2) // message, tool/call, tool/result
  assert.equal(t1.spanStart, null)
  assert.deepEqual(sim.state.open, ['T1'])
  assert.equal(sim.state.nextId, 2)
  const { seq: next } = sim.batch([{ kind: 'other' }])
  assert.equal(task(sim, 'T1').spanStart, next)
})

test('task_end queues the task; the next assistant message makes it due', () => {
  const sim = new Sim()
  sim.begin()
  sim.work(3)
  const { seq: endMsg } = sim.end()
  const t1 = task(sim, 'T1')
  assert.equal(t1.status, 'queued')
  assert.equal(t1.endMsgSeq, endMsg)
  assert.equal(t1.endCallId, 'call_4')
  assert.equal(t1.endCut, endMsg + 2)
  assert.equal(t1.reported, false)
  assert.deepEqual(dueTasks(sim.state), [])
  assert.deepEqual(
    dueTasks(sim.state, { turnStopping: true }).map((t) => t.id),
    ['T1'],
  )
  sim.say()
  assert.equal(task(sim, 'T1').reported, true)
  assert.deepEqual(
    dueTasks(sim.state).map((t) => t.id),
    ['T1'],
  )
  assertFoldableAndBalanced(sim, 'T1')
  const node = sim.fold('T1')
  const folded = task(sim, 'T1')
  assert.equal(folded.status, 'folded')
  assert.equal(folded.foldIndex, 0)
  assert.deepEqual(sim.state.folds[0], {
    summarySeq: node - 1,
    nodeSeq: node,
    taskId: 'T1',
    shadowedCount: sim.state.folds[0]?.shadowedCount,
    shadowedTokens: sim.state.folds[0]?.shadowedTokens,
  })
  assert.ok((sim.state.folds[0]?.shadowedCount ?? 0) > 0)
})

test('relay: task_end(A) and task_begin(B) in one batch give adjacent spans', () => {
  const sim = new Sim()
  sim.begin('A')
  sim.work(2)
  sim.batch([{ kind: 'end' }, { kind: 'begin', title: 'B' }])
  const a = task(sim, 'T1')
  const b = task(sim, 'T2')
  assert.equal(a.status, 'queued')
  assert.equal(b.status, 'open')
  assert.equal(a.endCut, b.beginCut)
  assert.equal(b.parent, null)
  sim.work(2)
  sim.fold('T1')
  const moved = task(sim, 'T2')
  assert.equal(moved.beginCut, sim.state.folds[0]?.nodeSeq, 'B now starts after A’s summary node')
  sim.end()
  sim.say()
  assertFoldableAndBalanced(sim, 'T2')
  sim.fold('T2')
  assert.equal(task(sim, 'T2').status, 'folded')
})

test('two begins in one batch get distinct ids and the second nests in the first', () => {
  const sim = new Sim()
  sim.batch([
    { kind: 'begin', title: 'outer' },
    { kind: 'begin', title: 'inner' },
  ])
  assert.deepEqual(sim.state.open, ['T1', 'T2'])
  assert.equal(task(sim, 'T2').parent, 'T1')
  assert.equal(task(sim, 'T2').depth, 1)
  assert.equal(task(sim, 'T1').beginCut, task(sim, 'T2').beginCut)
})

test('nested tasks fold inner first; the outer fold contains the inner summary node', () => {
  const sim = new Sim()
  sim.begin('outer')
  sim.work()
  sim.begin('inner')
  sim.work(2)
  sim.end()
  sim.say()
  assert.deepEqual(
    dueTasks(sim.state).map((t) => t.id),
    ['T2'],
  )
  sim.fold('T2')
  sim.work()
  sim.end()
  sim.say()
  assertFoldableAndBalanced(sim, 'T1')
  const innerNode = sim.state.folds[0]?.nodeSeq
  const region = resolveRegion(task(sim, 'T1'), sim.nodes)
  assert.equal(region.kind, 'fold')
  if (region.kind === 'fold')
    assert.ok(
      sim.nodes.slice(region.startIndex, region.endIndex + 1).includes(/** @type {number} */ (innerNode)),
    )
  sim.fold('T1')
  assert.equal(task(sim, 'T1').status, 'folded')
  assert.equal(sim.state.folds[1]?.taskId, 'T1')
})

test('due order is inner-first, then close order', () => {
  const sim = new Sim()
  sim.begin('a')
  sim.work()
  sim.end()
  sim.begin('b')
  sim.begin('b.1')
  sim.work()
  sim.end()
  sim.say()
  assert.deepEqual(
    dueTasks(sim.state).map((t) => t.id),
    ['T3', 'T1'],
  )
})

test('closing a parent closes its open descendants as merged', () => {
  const sim = new Sim()
  sim.begin('parent')
  sim.work()
  sim.begin('child')
  sim.work()
  sim.end({ id: 'T1' })
  assert.equal(task(sim, 'T1').status, 'queued')
  assert.equal(task(sim, 'T2').status, 'merged')
  assert.deepEqual(sim.state.open, [])
})

test('begin and end of the same task in one batch close below the floor', () => {
  const sim = new Sim()
  sim.batch([{ kind: 'begin' }, { kind: 'end' }])
  assert.equal(task(sim, 'T1').status, 'below-floor')
})

test('verdicts below-floor and delegate come from meta', () => {
  const sim = new Sim()
  sim.begin()
  sim.work()
  sim.end({ verdict: 'below-floor' })
  sim.begin()
  sim.work()
  sim.end({ verdict: 'delegate' })
  assert.equal(task(sim, 'T1').status, 'below-floor')
  assert.equal(task(sim, 'T2').status, 'delegate')
})

test('an auto compaction that swallows an open task’s begin cut makes its close absorbed', () => {
  const sim = new Sim()
  sim.user()
  sim.begin()
  sim.work(3)
  const t1 = task(sim, 'T1')
  sim.compact(/** @type {number} */ (sim.nodes[1]), /** @type {number} */ (t1.beginCut))
  assert.equal(task(sim, 'T1').beginCut, sim.state.folds[0]?.nodeSeq, 'cut moved: range ended exactly at it')
  sim.compact(/** @type {number} */ (sim.nodes[1]), /** @type {number} */ (sim.nodes[3]))
  assert.equal(task(sim, 'T1').beginCut, ABSORBED)
  assert.equal(task(sim, 'T1').status, 'open')
  sim.end()
  assert.equal(task(sim, 'T1').status, 'absorbed')
})

test('a task whose meta says queued but whose begin was absorbed closes absorbed', () => {
  const sim = new Sim()
  sim.user()
  sim.begin()
  sim.work(3)
  sim.compact(/** @type {number} */ (sim.nodes[1]), /** @type {number} */ (sim.nodes[4]))
  assert.equal(task(sim, 'T1').beginCut, ABSORBED)
  // Emulate a tool that did not notice (stale state): meta still says queued.
  const { ids } = sim.assistant([{ name: 'task_end' }])
  const id = /** @type {string} */ (ids[0])
  sim.result(id, {
    meta: {
      tf: 1,
      op: 'end',
      id: 'T1',
      merged: [],
      verdict: 'queued',
      outcome: 'done',
      estTokens: 9000,
      summaryChars: 500,
      callId: id,
    },
  })
  assert.equal(task(sim, 'T1').status, 'absorbed')
})

test('an auto compaction that covers part of a waiting task absorbs it', () => {
  const sim = new Sim()
  sim.user()
  sim.begin()
  sim.work(3)
  sim.end()
  sim.compactHead(6)
  assert.equal(task(sim, 'T1').status, 'absorbed')
  assert.equal(sim.state.folds[0]?.taskId, null)
})

test('pruning the task_end result moves the end cut and does not re-apply its meta', () => {
  const sim = new Sim()
  sim.begin()
  sim.work(2)
  sim.end()
  const before = task(sim, 'T1')
  const pruned = sim.prune(/** @type {number} */ (before.endCut))
  const after = task(sim, 'T1')
  assert.equal(after.endCut, pruned)
  assert.equal(after.status, 'queued')
  assert.deepEqual(sim.state.open, [])
  assert.equal(sim.state.order.length, 1)
  sim.say()
  assertFoldableAndBalanced(sim, 'T1')
  sim.fold('T1')
  assert.equal(task(sim, 'T1').status, 'folded')
})

test('pruning the task_begin result moves the begin cut and does not open a second task', () => {
  const sim = new Sim()
  sim.begin()
  const pruned = sim.prune(/** @type {number} */ (task(sim, 'T1').beginCut))
  assert.equal(task(sim, 'T1').beginCut, pruned)
  assert.deepEqual(sim.state.open, ['T1'])
  sim.work(2)
  sim.end()
  sim.say()
  assertFoldableAndBalanced(sim, 'T1')
})

test('pruning a result inside a span leaves the cuts alone', () => {
  const sim = new Sim()
  sim.begin()
  sim.work(3)
  const inside = /** @type {number} */ (sim.nodes[sim.nodes.length - 1])
  const before = sim.state.tasks
  sim.prune(inside)
  assert.equal(sim.state.tasks, before)
})

test('an interrupted batch is closed by step/end', () => {
  const sim = new Sim()
  sim.batch([{ kind: 'begin' }, { kind: 'other' }], { drop: 1 })
  assert.equal(sim.state.batch, null)
  assert.equal(task(sim, 'T1').status, 'open')
})

test('an interrupted batch without step/end is closed by the next assistant message', () => {
  const sim = new Sim()
  sim.batch([{ kind: 'begin' }, { kind: 'other' }], { drop: 1, stepEnd: false })
  assert.notEqual(sim.state.batch, null)
  assert.equal(task(sim, 'T1').status, 'opening')
  const { seq } = sim.say()
  assert.equal(sim.state.batch, null)
  assert.equal(task(sim, 'T1').status, 'open')
  assert.equal(task(sim, 'T1').spanStart, seq)
})

test('step/end without a batch changes nothing', () => {
  const sim = new Sim()
  const before = sim.state
  sim.stepEnd()
  assert.equal(sim.state, before)
})

test('a failed task_end call (no meta) changes no task', () => {
  const sim = new Sim()
  sim.end()
  assert.deepEqual(sim.state.order, [])
  sim.begin()
  sim.end({ id: 'T9' })
  assert.equal(task(sim, 'T1').status, 'open')
})

test('delegate tasks fail after repeated compaction failures; queued tasks do not', () => {
  const sim = new Sim()
  sim.begin()
  sim.work()
  sim.end({ verdict: 'delegate' })
  sim.begin()
  sim.work()
  sim.end()
  for (let i = 0; i < MAX_DELEGATE_FAILURES - 1; i++) sim.failCompaction()
  assert.equal(task(sim, 'T1').status, 'delegate')
  assert.equal(task(sim, 'T1').failures, MAX_DELEGATE_FAILURES - 1)
  sim.failCompaction()
  assert.equal(task(sim, 'T1').status, 'failed')
  assert.equal(task(sim, 'T2').status, 'queued')
  const before = sim.state
  sim.failCompaction()
  assert.equal(sim.state, before, 'nothing left to count')
})

test('a successful compaction/end changes nothing', () => {
  const sim = new Sim()
  const before = sim.state
  sim.push({ type: 'compaction/end', data: { compactionId: 'x' } })
  sim.push({ type: 'compaction/end', data: { compactionId: 'y', error: null } })
  sim.push({ type: 'compaction/end' })
  assert.equal(sim.state, before)
})

test('the hint latch follows hint messages and ignores other user messages', () => {
  const sim = new Sim()
  sim.user('plain')
  assert.equal(sim.state.hintKey, null)
  sim.hint('T1:25')
  assert.equal(sim.state.hintKey, 'T1:25')
  const before = sim.state
  sim.hint('T1:25')
  assert.equal(sim.state.hintKey, before.hintKey)
  sim.user('bad hint', { kind: 'task-folding:hint' })
  assert.equal(sim.state.hintKey, 'T1:25')
  sim.push({ type: 'user/message', surfaceOp: 'append' })
  assert.equal(sim.state.hintKey, 'T1:25')
})

test('request/header is remembered', () => {
  const sim = new Sim()
  const seq = sim.header()
  assert.equal(sim.state.lastHeaderSeq, seq)
})

test('compaction/summary without fields still records a fold row', () => {
  const sim = new Sim()
  sim.push({ type: 'compaction/summary' })
  assert.deepEqual(sim.state.folds, [
    { summarySeq: 1, nodeSeq: null, taskId: null, shadowedCount: 0, shadowedTokens: 0 },
  ])
  assert.equal(sim.state.pendingSummary, 0)
})

test('malformed, unknown and out-of-batch meta is ignored', () => {
  const sim = new Sim()
  const base = sim.state
  // meta on a result outside any batch
  sim.assistant([{ name: 'read' }])
  const { ids } = sim.assistant([{ name: 'read' }])
  sim.result(/** @type {string} */ (ids[0]), {
    meta: { tf: 1, op: 'begin', id: 'T1', title: 'x', parent: null },
  })
  assert.deepEqual(sim.state.order, base.order)

  const m = sim.assistant([
    { name: 'task_begin' },
    { name: 'task_begin' },
    { name: 'task_begin' },
    { name: 'task_end' },
  ])
  const [a, b, c, d] = /** @type {[string, string, string, string]} */ (m.ids)
  sim.result(a, { meta: { tf: 1, op: 'begin', id: 'X1', title: 'bad id', parent: null } })
  sim.result(b, { meta: { tf: 1, op: 'begin', id: 'T5', title: 'ok', parent: 'T404' } })
  sim.result(c, { meta: { tf: 1, op: 'begin', id: 'T5', title: 'dup', parent: null } })
  sim.result(d, {
    meta: {
      tf: 1,
      op: 'end',
      id: 'T77',
      merged: [],
      verdict: 'queued',
      outcome: 'done',
      estTokens: 1,
      summaryChars: 1,
      callId: d,
    },
  })
  assert.deepEqual(sim.state.order, ['T5'])
  assert.equal(task(sim, 'T5').title, 'ok')
  assert.equal(task(sim, 'T5').parent, null, 'unknown parent ignored')
  assert.equal(sim.state.nextId, 6)
  // a result for a call that is not in the batch
  const n = sim.assistant([{ name: 'task_end' }])
  sim.result('call_unknown', {
    meta: {
      tf: 1,
      op: 'end',
      id: 'T5',
      merged: [],
      verdict: 'queued',
      outcome: 'done',
      estTokens: 1,
      summaryChars: 1,
      callId: 'x',
    },
  })
  assert.equal(task(sim, 'T5').status, 'open')
  sim.result(/** @type {string} */ (n.ids[0]))
  assert.equal(sim.state.batch, null)
})

test('end meta for a task that is already closing is ignored', () => {
  const sim = new Sim()
  sim.begin()
  const m = sim.assistant([{ name: 'task_end' }, { name: 'task_end' }])
  const [a, b] = /** @type {[string, string]} */ (m.ids)
  const end = (/** @type {string} */ id) => ({
    tf: 1,
    op: 'end',
    id: 'T1',
    merged: ['T1', 'T9'],
    verdict: 'queued',
    outcome: 'done',
    estTokens: 1,
    summaryChars: 1,
    callId: id,
  })
  sim.result(a, { meta: end(a) })
  sim.result(b, { meta: end(b) })
  assert.equal(task(sim, 'T1').status, 'queued', 'the span is the end batch itself')
  assert.equal(task(sim, 'T1').endCallId, a)
})

test('meta validators', () => {
  assert.equal(isBeginMeta(null), false)
  assert.equal(isBeginMeta([]), false)
  assert.equal(isBeginMeta({ tf: 2, op: 'begin', id: 'T1', title: 'x', parent: null }), false)
  assert.equal(isBeginMeta({ tf: 1, op: 'begin', id: 'T1', title: 'x', parent: 3 }), false)
  assert.equal(isBeginMeta({ tf: 1, op: 'begin', id: 'T1', title: 'x', parent: 'T0' }), true)
  const end = {
    tf: 1,
    op: 'end',
    id: 'T1',
    merged: [],
    verdict: 'queued',
    outcome: 'done',
    estTokens: 1,
    summaryChars: 1,
    callId: 'c',
  }
  assert.equal(isEndMeta(end), true)
  assert.equal(isEndMeta({ ...end, op: 'begin' }), false)
  assert.equal(isEndMeta({ ...end, merged: [1] }), false)
  assert.equal(isEndMeta({ ...end, verdict: 'folded' }), false)
  assert.equal(isEndMeta({ ...end, outcome: 'meh' }), false)
  assert.equal(isEndMeta({ ...end, estTokens: '1' }), false)
  assert.equal(isEndMeta({ ...end, callId: 1 }), false)
})

test('toolCalls reads only well-formed tool-call blocks', () => {
  assert.deepEqual(toolCalls({ type: 'assistant/message', seq: 1 }), [])
  assert.deepEqual(
    toolCalls({
      type: 'assistant/message',
      seq: 1,
      data: {
        message: {
          content: [
            null,
            { type: 'text' },
            { type: 'tool-call', id: 1, name: 'x' },
            { type: 'tool-call', id: 'a', name: 'b' },
          ],
        },
      },
    }),
    [{ id: 'a', name: 'b' }],
  )
})

test('replace ops on non-surface events or with malformed ranges are ignored', () => {
  const state = initialState()
  assert.equal(
    apply(state, { type: 'compaction/prune', seq: 1, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } }),
    state,
  )
  const odd = /** @type {any} */ ({ op: 'replace', startSeq: '1', endSeq: 2 })
  const next = apply(state, { type: 'tool/result', seq: 2, surfaceOp: odd })
  assert.equal(next, state)
  const other = /** @type {any} */ ({ op: 'move' })
  assert.equal(apply(state, { type: 'tool/result', seq: 3, surfaceOp: other }), state)
})

test('a replacement with no pending fold row and no tracked cuts changes only the epoch', () => {
  const sim = new Sim()
  sim.work()
  const before = sim.state
  sim.prune(/** @type {number} */ (sim.nodes[sim.nodes.length - 1]))
  assert.equal(sim.state.tasks, before.tasks, 'no task was translated')
  assert.equal(sim.state.folds, before.folds)
  assert.equal(sim.state.surfaceEpoch, before.surfaceEpoch + 1, 'the surface version moved anyway')
  assert.equal(sim.state.surfaceEpoch, 1)
})

test('a replacement without sourceEventSeqs translates nothing', () => {
  const sim = new Sim()
  sim.begin()
  const before = sim.state.tasks
  sim.push({ type: 'tool/result', data: {}, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 } })
  assert.equal(sim.state.tasks, before)
})

test('a checkpoint whose fold row was lost still gets a node seq when no task matches', () => {
  const sim = new Sim()
  sim.user()
  sim.work(2)
  sim.compactHead(4)
  assert.equal(typeof sim.state.folds[0]?.nodeSeq, 'number')
})

test('view lists open, folding and recent tasks and is memoized', () => {
  const sim = new Sim()
  for (let i = 0; i < RECENT_LIMIT + 2; i++) {
    sim.begin()
    sim.work()
    sim.end({ verdict: 'below-floor' })
  }
  sim.begin('waiting')
  sim.work()
  sim.end()
  sim.begin('outer')
  sim.begin('inner')
  const v = view(sim.state)
  assert.deepEqual(v.open, [
    { id: 'T9', title: 'outer', depth: 0 },
    { id: 'T10', title: 'inner', depth: 1 },
  ])
  assert.deepEqual(v.folding, [{ id: 'T8', title: 'waiting' }])
  assert.equal(v.recent.length, RECENT_LIMIT)
  assert.equal(v.recent[RECENT_LIMIT - 1]?.id, 'T7')
  assert.equal(view(sim.state), v)
  assert.equal(view({ ...sim.state, assistantCount: 99 }), v, 'unrelated changes keep the view')
  assert.notEqual(view({ ...sim.state, open: ['T9'] }), v)
  const broken = { ...sim.state, tasks: { ...sim.state.tasks }, open: ['T404', 'T9'], order: ['T404', 'T9'] }
  assert.deepEqual(view(broken).open, [{ id: 'T9', title: 'outer', depth: 0 }])
})

test('parseState accepts states the reducer produced and rejects anything else', () => {
  const sim = new Sim()
  sim.begin()
  sim.work()
  sim.end()
  sim.header()
  sim.hint('T1:25')
  sim.push({ type: 'compaction/summary' })
  const round = JSON.parse(JSON.stringify(sim.state))
  assert.deepEqual(parseState(round), sim.state)
  assert.equal(stateSchema.parse, parseState)

  const bad = (/** @type {object} */ patch) => () => parseState({ ...round, ...patch })
  assert.throws(() => parseState(null), /root/)
  assert.throws(bad({ nextId: 0 }), /nextId/)
  assert.throws(bad({ nextId: 1.5 }), /nextId/)
  assert.throws(bad({ open: [1] }), /open/)
  assert.throws(bad({ order: 'T1' }), /order/)
  assert.throws(bad({ tasks: [] }), /tasks/)
  assert.throws(bad({ tasks: {} }), /task T1/)
  assert.throws(bad({ tasks: { T1: { id: 'T2', status: 'open' } } }), /task T1/)
  assert.throws(bad({ batch: 3 }), /batch/)
  assert.throws(bad({ assistantCount: 'x' }), /assistantCount/)
  assert.throws(bad({ folds: {} }), /folds/)
  assert.throws(bad({ pendingSummary: 'x' }), /pendingSummary/)
  assert.throws(bad({ hintKey: 3 }), /hintKey/)
  assert.throws(bad({ lastHeaderSeq: 'x' }), /lastHeaderSeq/)
  assert.doesNotThrow(
    bad({ batch: { msgSeq: 1, waiting: [], last: 1, begins: [], ends: [] }, pendingSummary: null }),
  )
})

test('unknown events return the same state', () => {
  const state = initialState()
  assert.equal(apply(state, { type: 'turn/start', seq: 0 }), state)
  assert.equal(apply(state, { type: 'tool/call', seq: 1, data: {} }), state)
})

test('parseView accepts the wire view and rejects malformed shapes', () => {
  const sim = new Sim()
  sim.begin('outer')
  sim.work()
  sim.begin('inner')
  sim.end()
  sim.begin('third')
  const live = view(sim.state)
  assert.deepEqual(parseView(live), live)
  assert.equal(viewSchema.parse, parseView)
  assert.deepEqual(parseView({ open: [], folding: [], recent: [] }), {
    open: [],
    folding: [],
    recent: [],
  })

  const ok = {
    open: [{ id: 'T1', title: 'a', depth: 0 }],
    folding: [{ id: 'T2', title: 'b' }],
    recent: [{ id: 'T3', title: 'c', status: 'folded' }],
  }
  assert.doesNotThrow(() => parseView(ok))
  assert.throws(() => parseView(null), /root/)
  assert.throws(() => parseView({ open: {}, folding: [], recent: [] }), /open/)
  assert.throws(() => parseView({ open: [{ id: 1, title: 'a', depth: 0 }], folding: [], recent: [] }), /open/)
  assert.throws(() => parseView({ open: ['T1'], folding: [], recent: [] }), /open/)
  assert.throws(() => parseView({ open: [], folding: [{ id: 'T2' }], recent: [] }), /folding/)
  assert.throws(() => parseView({ open: [], folding: { id: 'T2' }, recent: [] }), /folding/)
  assert.throws(() => parseView({ open: [], folding: [], recent: [{ id: 'T3', title: 'c' }] }), /recent/)
  assert.throws(() => parseView({ open: [], folding: [] }), /recent/)
})
