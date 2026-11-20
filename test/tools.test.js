// The tool layer (docs/03 §6, docs/04 §1): ids, parents, titles, verdicts, meta and the
// rendered text — executed the way the host executes them, against a Sim session.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isBeginMeta, isEndMeta } from '../host/projection.js'
import { defaults, readSettings } from '../host/settings.js'
import * as texts from '../host/texts.js'
import { TITLE_MAX, decideVerdict, normalizeTitle } from '../host/tools.js'
import { Sim } from './fixtures/sim.js'
import { at, fakeMeter, harnessOf, withVolatiles } from './fixtures/tools.js'

/** A summary that clears minSummaryChars without being large. */
const SUMMARY = `## Done\n${'Wired the tool layer and checked it against the simulator. '.repeat(5)}`
const LONG_SUMMARY = `## Done\n${'Everything the task needed, described at length. '.repeat(10)}`

/** @param {number} [perMessage] */
function harness(perMessage = 1000) {
  const sim = new Sim()
  return { sim, h: harnessOf(sim, { meter: fakeMeter({ perMessage }) }) }
}

test('normalizeTitle collapses whitespace, trims and caps', () => {
  assert.equal(normalizeTitle('  Fix\n the   redirect\tloop  '), 'Fix the redirect loop')
  assert.equal(normalizeTitle('x'.repeat(200)).length, TITLE_MAX)
  assert.equal(normalizeTitle('   \n  '), '')
  assert.equal(normalizeTitle(undefined), '')
  assert.equal(normalizeTitle(42), '')
  assert.equal(normalizeTitle(`${'a'.repeat(TITLE_MAX)} bcd`).endsWith(' '), false)
})

test('task_begin returns an id, a parent and a depth and writes BeginMeta', async () => {
  const { sim, h } = harness()
  const outer = await h.batch([{ name: 'task_begin', args: { title: 'outer' } }])
  assert.deepEqual(at(outer, 0).value, { ok: true, id: 'T1', title: 'outer', parent: null, depth: 0 })
  assert.equal(at(outer, 0).text, 'Task T1 opened.')
  assert.ok(isBeginMeta(at(outer, 0).meta))
  assert.deepEqual(at(outer, 0).meta, { tf: 1, op: 'begin', id: 'T1', title: 'outer', parent: null })

  const inner = await h.batch([{ name: 'task_begin', args: { title: 'inner' } }])
  assert.deepEqual(at(inner, 0).value, { ok: true, id: 'T2', title: 'inner', parent: 'T1', depth: 1 })
  assert.equal(at(inner, 0).text, 'Task T2 opened (inside T1).')
  assert.deepEqual(sim.state.open, ['T1', 'T2'])
})

test('two begins in one batch take consecutive ids', async () => {
  const { h } = harness()
  const out = await h.batch([
    { name: 'task_begin', args: { title: 'first' } },
    { name: 'task_begin', args: { title: 'second' } },
  ])
  assert.equal(at(out, 0).value.id, 'T1')
  assert.equal(at(out, 1).value.id, 'T2')
  // The native executor commits each result before the next call, so the second begin sees
  // the first task open; the reducer then treats T2 as begun inside T1 and merges it on close.
  assert.equal(at(out, 1).value.parent, 'T1')
})

test('an empty title is an error and writes no meta', async () => {
  const { sim, h } = harness()
  await assert.rejects(h.call('task_begin', { title: '   ' }), /task_begin failed: the title is empty/)
  await assert.rejects(h.call('task_begin', {}), /the title is empty/)
  assert.deepEqual(sim.state.open, [])
})

test('nested PTC calls are refused', async () => {
  const { h } = harness()
  await assert.rejects(
    h.call('task_begin', { title: 'x' }, { callId: 'root:ptc:1', rootCallId: 'root' }),
    /call task_begin directly, not from run_code/,
  )
  await assert.rejects(
    h.call('task_end', { summary: SUMMARY }, { callId: 'root:ptc:1', rootCallId: 'root' }),
    /call task_end directly, not from run_code/,
  )
  await assert.rejects(
    h.call('fold_recall', {}, { callId: 'root:ptc:1', rootCallId: 'root' }),
    /call fold_recall directly, not from run_code/,
  )
})

test('a call without an exec context is refused', async () => {
  const { h } = harness()
  await assert.rejects(
    h.byName.task_begin.execute({ title: 'x' }, {}),
    /task_begin failed: task folding is not ready yet/,
  )
})

test('task_end closes the innermost task by default and reports what remains', async () => {
  const { sim, h } = harness()
  await h.batch([{ name: 'task_begin', args: { title: 'outer' } }])
  await h.batch([{ name: 'task_begin', args: { title: 'inner' } }])
  sim.work(3)
  const end = await h.one([{ name: 'task_end', args: { summary: SUMMARY } }])
  assert.equal(end.value.id, 'T2')
  assert.equal(end.value.verdict, 'queued')
  assert.deepEqual(end.value.merged, [])
  assert.deepEqual(end.value.remaining, ['T1'])
  assert.equal(end.text, 'Task T2 closed; it will be folded into your summary. Open: T1.')
  assert.ok(isEndMeta(end.meta))
  assert.equal(end.meta.id, 'T2')
  assert.equal(end.meta.outcome, 'done')
  assert.equal(end.meta.callId, end.meta.callId)
  assert.ok(end.meta.callId.startsWith('call_'))
  assert.equal(end.meta.summaryChars, SUMMARY.length)
  assert.deepEqual(sim.state.open, ['T1'])
})

test('task_end with an explicit id closes that task and its open subtasks', async () => {
  const { sim, h } = harness()
  await h.batch([{ name: 'task_begin', args: { title: 'outer' } }])
  await h.batch([{ name: 'task_begin', args: { title: 'inner' } }])
  sim.work(3)
  const end = await h.one([{ name: 'task_end', args: { summary: SUMMARY, id: 'T1' } }])
  assert.equal(end.value.id, 'T1')
  assert.deepEqual(end.value.merged, ['T2'])
  assert.deepEqual(end.value.remaining, [])
  assert.equal(
    end.text,
    'Task T1 closed; it will be folded into your summary. No open tasks. Subtasks closed with it: T2.',
  )
  assert.deepEqual(end.meta.merged, ['T2'])
  assert.deepEqual(sim.state.open, [])
  assert.equal(taskOf(sim.state, 'T2').status, 'merged')
})

test('task_end without an open task or with an unknown id is an error', async () => {
  const { h } = harness()
  await assert.rejects(h.call('task_end', { summary: SUMMARY }), /task_end failed: no task is open/)
  await h.batch([{ name: 'task_begin', args: { title: 'only' } }])
  await assert.rejects(
    h.call('task_end', { summary: SUMMARY, id: 'T9' }),
    /task_end failed: task T9 is not open. Open tasks: T1./,
  )
  await assert.rejects(h.call('task_end', { summary: SUMMARY, id: 7 }), /task 7 is not open/)
  await assert.rejects(
    h.call('task_end', { summary: SUMMARY, outcome: 'maybe' }),
    /outcome must be done, failed or abandoned/,
  )
})

test('outcome is recorded: failed and abandoned reach the meta', async () => {
  const { sim, h } = harness()
  await h.batch([{ name: 'task_begin', args: { title: 'one' } }])
  sim.work(3)
  const end = await h.one([{ name: 'task_end', args: { summary: SUMMARY, outcome: 'failed' } }])
  assert.equal(end.meta.outcome, 'failed')
  assert.equal(taskOf(sim.state, 'T1').outcome, 'failed')
})

test('verdict queued: a large span and a usable summary', async () => {
  const { sim, h } = harness()
  await h.batch([{ name: 'task_begin', args: { title: 'big' } }])
  sim.work(5)
  const end = await h.one([{ name: 'task_end', args: { summary: SUMMARY } }])
  assert.equal(end.value.verdict, 'queued')
  assert.ok(end.value.estTokens >= 5000, `estTokens ${end.value.estTokens}`)
  assert.equal(end.meta.verdict, 'queued')
})

test('verdict below-floor: a span under minSpanTokens', async () => {
  const { sim, h } = harness(100)
  await h.batch([{ name: 'task_begin', args: { title: 'small' } }])
  sim.work(1)
  const end = await h.one([{ name: 'task_end', args: { summary: SUMMARY } }])
  assert.equal(end.value.verdict, 'below-floor')
  assert.equal(end.text, 'Task T1 closed; it is small, so its messages stay as they are. No open tasks.')
})

test('verdict below-floor: a task begun and closed without a step in between', async () => {
  const { h } = harness()
  const results = await h.batch([
    { name: 'task_begin', args: { title: 'relay' } },
    { name: 'task_end', args: { summary: LONG_SUMMARY } },
  ])
  const begin = at(results, 0)
  const end = at(results, 1)
  assert.equal(begin.value.id, 'T1')
  assert.equal(end.value.verdict, 'below-floor')
  assert.equal(end.value.estTokens, 0)
})

test('verdict absorbed: a compaction swallowed the task start', async () => {
  const { sim, h } = harness()
  sim.user('do something')
  await h.batch([{ name: 'task_begin', args: { title: 'head' } }])
  sim.work(2)
  absorbThrough(sim, sim.nodes.at(-1))
  assert.equal(taskOf(sim.state, 'T1').beginCut, -1)
  const end = await h.one([{ name: 'task_end', args: { summary: LONG_SUMMARY } }])
  assert.equal(end.value.verdict, 'absorbed')
  assert.equal(end.value.estTokens, -1)
  assert.equal(end.meta.verdict, 'absorbed')
  assert.equal(
    end.text,
    'Task T1 closed; its beginning was already compacted, so it gets no separate fold. No open tasks.',
  )
})

test('verdict delegate: a summary shorter than minSummaryChars', async () => {
  const { sim, h } = harness()
  await h.batch([{ name: 'task_begin', args: { title: 'thin' } }])
  sim.work(5)
  const end = await h.one([{ name: 'task_end', args: { summary: 'Fixed it.' } }])
  assert.equal(end.value.verdict, 'delegate')
  assert.equal(
    end.text,
    'Task T1 closed; the summary was too short or too long for this span, so it will be summarized automatically. No open tasks.',
  )
})

test('verdict delegate: a summary too large a share of the span', async () => {
  const sim = new Sim()
  const h = harnessOf(sim, { meter: fakeMeter({ perMessage: 100, perChar: 1 }) })
  await h.batch([{ name: 'task_begin', args: { title: 'long summary' } }])
  sim.work(30) // ~6k tokens of span
  const huge = 'x'.repeat(4000)
  const end = await h.one([{ name: 'task_end', args: { summary: huge } }])
  assert.equal(end.value.verdict, 'delegate')
  assert.ok(end.value.estTokens > 0)
})

test('delegateEnabled=false falls back to queued', async () => {
  const sim = new Sim()
  const h = harnessOf(sim, { meter: fakeMeter(), settings: { delegateEnabled: false } })
  await h.batch([{ name: 'task_begin', args: { title: 'no delegate' } }])
  sim.work(5)
  const end = await h.one([{ name: 'task_end', args: { summary: 'Short.' } }])
  assert.equal(end.value.verdict, 'queued')
})

test('decideVerdict is a pure function of the task and the settings', () => {
  const settings = readSettings(withVolatiles(defaults()))
  const open = fakeTask({ beginCut: 3, spanStart: 4, endCut: 9, status: 'open' })
  assert.equal(decideVerdict(open, SUMMARY, 100, 5000, settings), 'queued')
  assert.equal(decideVerdict(open, SUMMARY, 100, 10, settings), 'below-floor')
  assert.equal(decideVerdict(open, 'tiny', 100, 5000, settings), 'delegate')
  assert.equal(decideVerdict(open, SUMMARY, 9000, 5000, settings), 'delegate')
  assert.equal(
    decideVerdict(fakeTask({ ...open, status: 'opening' }), SUMMARY, 1, 5000, settings),
    'below-floor',
  )
  assert.equal(decideVerdict(fakeTask({ ...open, beginCut: -1 }), SUMMARY, 1, 5000, settings), 'absorbed')
})

test('fold_recall lists folds and refuses detail work in this milestone', async () => {
  const { sim, h } = harness()
  const empty = await h.call('fold_recall', {})
  assert.equal(empty.text, 'No folds yet.')
  assert.equal(empty.meta, undefined)

  await h.batch([{ name: 'task_begin', args: { title: 'folded one' } }])
  sim.work(2)
  absorbThrough(sim, sim.nodes.at(-1))
  const list = await h.call('fold_recall', {})
  assert.match(list.text, /^Folds \(1\):/)
  assert.match(list.text, /#1 auto compaction · \d+ msgs · ~[\d.]+k? tokens/)

  const detail = await h.call('fold_recall', { fold: 1 })
  assert.equal(detail.text, texts.RECALL_NOT_AVAILABLE)
  const byTask = await h.call('fold_recall', { task: 'T1' })
  assert.equal(byTask.text, texts.RECALL_NOT_AVAILABLE)
})

test('a task id is not reused after the projection has moved on', async () => {
  const { h } = harness()
  const first = await h.batch([{ name: 'task_begin', args: { title: 'a' } }])
  await h.batch([{ name: 'task_begin', args: { title: 'b' } }])
  const third = await h.batch([{ name: 'task_begin', args: { title: 'c' } }])
  assert.deepEqual([at(first, 0).value.id, at(third, 0).value.id], ['T1', 'T3'])
})

test('the simulator driven by the real tools reaches the same state as synthetic meta', async () => {
  const real = await scenario((sim, h) => runReal(sim, h))
  const synthetic = await scenario((sim) => runSynthetic(sim))
  assert.deepEqual(shape(real.state), shape(synthetic.state))
  // The relay produced adjacent intervals, as ADR 0002 requires.
  assert.equal(taskOf(real.state, 'T2').endCut, taskOf(real.state, 'T3').beginCut)
  assert.equal(taskOf(real.state, 'T1').status, 'queued')
  assert.equal(taskOf(real.state, 'T2').status, 'queued')
  assert.equal(taskOf(real.state, 'T3').status, 'queued')
})

test('a task closed while its parent stays open keeps the parent stack intact', async () => {
  const { sim, h } = harness()
  await h.batch([{ name: 'task_begin', args: { title: 'parent' } }])
  await h.batch([{ name: 'task_begin', args: { title: 'child' } }])
  sim.work(3)
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])
  assert.deepEqual(sim.state.open, ['T1'])
  sim.work(3)
  const end = await h.one([{ name: 'task_end', args: { summary: SUMMARY } }])
  assert.equal(end.value.id, 'T1')
  assert.deepEqual(sim.state.open, [])
  assert.deepEqual(sim.state.order, ['T1', 'T2'])
})

// ---------------------------------------------------------------------------
// Helpers

/**
 * Compact from the second surface node through `seq`, snapping the end back to the last
 * tool-pairing balanced position at or before it. Any tracked cut inside the range that is
 * not its last node is absorbed.
 *
 * @param {Sim} sim
 * @param {number | undefined} seq
 */
function absorbThrough(sim, seq) {
  assert.ok(seq !== undefined)
  let end = sim.nodes.indexOf(seq)
  while (end > 0 && !sim.balancedRange(1, end)) end--
  assert.ok(end > 0, 'no balanced range to compact')
  sim.compact(/** @type {number} */ (sim.nodes[1]), /** @type {number} */ (sim.nodes[end]))
}

/**
 * @param {(sim: Sim, h: ReturnType<typeof harnessOf>) => Promise<void>} drive
 */
async function scenario(drive) {
  const sim = new Sim()
  const h = harnessOf(sim, { meter: fakeMeter() })
  await drive(sim, h)
  return { sim, state: sim.state }
}

/**
 * @param {Sim} sim
 * @param {ReturnType<typeof harnessOf>} h
 */
async function runReal(sim, h) {
  sim.user('read stuff')
  await h.batch([{ name: 'task_begin', args: { title: 'outer' } }])
  await h.batch([{ name: 'task_begin', args: { title: 'inner' } }])
  sim.work(2)
  await h.batch([
    { name: 'task_end', args: { summary: SUMMARY } },
    { name: 'task_begin', args: { title: 'sibling' } },
  ])
  sim.work(1)
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])
  sim.say()
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])
}

/** @param {Sim} sim */
async function runSynthetic(sim) {
  sim.user('read stuff')
  sim.begin('outer')
  sim.begin('inner')
  sim.work(2)
  sim.batch([{ kind: 'end' }, { kind: 'begin', title: 'sibling' }])
  sim.work(1)
  sim.end()
  sim.say()
  sim.end()
}

/**
 * A task with only the fields decideVerdict reads.
 *
 * @param {Partial<import('../host/types.js').Task>} patch
 * @returns {import('../host/types.js').Task}
 */
function fakeTask(patch) {
  return /** @type {import('../host/types.js').Task} */ (/** @type {unknown} */ (patch))
}

/**
 * @param {import('../host/types.js').State} state
 * @param {string} id
 * @returns {import('../host/types.js').Task}
 */
function taskOf(state, id) {
  const task = state.tasks[id]
  assert.ok(task, `task ${id} exists`)
  return task
}

/**
 * The projection fields that must match between a real-tool run and a synthetic run;
 * estTokens and summaryChars come from the tools and differ by construction.
 *
 * @param {import('../host/types.js').State} state
 */
function shape(state) {
  return state.order.map((id) => {
    const task = taskOf(state, id)
    return {
      id,
      parent: task.parent,
      depth: task.depth,
      status: task.status,
      beginCut: task.beginCut,
      spanStart: task.spanStart,
      endCut: task.endCut,
      verdict: task.verdict,
    }
  })
}
