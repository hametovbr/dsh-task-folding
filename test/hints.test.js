// The stale-task hint (docs/03 §8, docs/04 §5): which task is stale, which bucket it names, the
// durable latch that stops a repeat, and the purity of the module that decides all of it.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { bucketFor, hintKeyFor, maybeHint } from '../host/hints.js'
import * as texts from '../host/texts.js'
import { Sim } from './fixtures/sim.js'
import { harnessOf } from './fixtures/tools.js'

/** @typedef {import('../host/hints.js').HintMessage} HintMessage */
/** @typedef {import('../host/settings.js').Settings} Settings */
/** @typedef {import('../host/types.js').State} State */

/**
 * A session with one open task, created through the real task_begin tool.
 *
 * @param {{ title?: string, settings?: object }} [options]
 * @returns {Promise<{ sim: Sim, h: ReturnType<typeof harnessOf> }>}
 */
async function openTask(options = {}) {
  const sim = new Sim()
  const h = harnessOf(sim, options.settings === undefined ? {} : { settings: options.settings })
  await h.batch([{ name: 'task_begin', args: { title: options.title ?? 'Fix login redirect loop' } }])
  return { sim, h }
}

/** @param {Sim} sim @param {number} count */
function say(sim, count) {
  for (let i = 0; i < count; i += 1) sim.say()
}

/**
 * The age docs/03 §8 defines: assistant messages since the task's begin batch closed.
 *
 * @param {Sim} sim
 * @returns {number}
 */
function ageOf(sim) {
  const id = sim.state.open.at(-1)
  const task = id === undefined ? undefined : sim.state.tasks[id]
  if (task === undefined) throw new Error('no open task')
  return sim.state.assistantCount - task.openedAt
}

/**
 * The key `maybeHint` would publish right now, or null.
 *
 * @param {Sim} sim
 * @param {{ settings: Settings }} h
 * @returns {string | null}
 */
function keyOf(sim, h) {
  return maybeHint(sim.state, h.settings)?.key ?? null
}

/**
 * @param {{ message: HintMessage } | null} hint
 * @returns {string}
 */
function textOf(hint) {
  if (hint === null) throw new Error('no hint')
  const block = hint.message.content[0]
  if (block === undefined) throw new Error('the hint has no text block')
  return block.text
}

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(/** @type {any} */ (value)[key])
  }
  return value
}

// ---------------------------------------------------------------------------
// When there is no hint

test('no open task and no stale task produce no hint', async () => {
  const sim = new Sim()
  const h = harnessOf(sim)
  say(sim, 30)
  assert.equal(maybeHint(sim.state, h.settings), null, 'a session without tasks is never stale')

  // A closed task leaves the stack, however long it stayed open before it closed.
  await h.batch([{ name: 'task_begin', args: { title: 'closed' } }])
  say(sim, 30)
  await h.batch([{ name: 'task_end', args: { summary: '## Done\nClosed.' } }])
  assert.deepEqual(sim.state.open, [])
  assert.equal(maybeHint(sim.state, h.settings), null)
})

test('an open task below the threshold is not stale', async () => {
  const { sim, h } = await openTask({ settings: { staleTaskSteps: 5 } })
  assert.equal(h.settings.staleTaskSteps, 5)
  say(sim, 4)
  assert.equal(ageOf(sim), 4)
  assert.equal(maybeHint(sim.state, h.settings), null)
})

test('an open id without a task is ignored, not an error', async () => {
  const { sim, h } = await openTask()
  say(sim, 25)
  const corrupt = /** @type {State} */ ({ ...sim.state, open: ['T9'] })
  assert.equal(maybeHint(corrupt, h.settings), null)
})

// ---------------------------------------------------------------------------
// Buckets

test('bucketFor scales the documented buckets with the configured threshold', () => {
  // A threshold of 2 gives 2, 4 and 8: the shortest way to show that the first bucket is the
  // setting and the next two are twice and four times it.
  assert.equal(bucketFor(1, 2), null)
  assert.equal(bucketFor(2, 2), 2)
  assert.equal(bucketFor(3, 2), 2)
  assert.equal(bucketFor(4, 2), 4)
  assert.equal(bucketFor(7, 2), 4)
  assert.equal(bucketFor(8, 2), 8)
  assert.equal(bucketFor(1000, 2), 8)

  // The documented default: 25, 50, 100 (docs/03 §8, docs/04 §5).
  assert.equal(bucketFor(24, 25), null)
  assert.equal(bucketFor(25, 25), 25)
  assert.equal(bucketFor(49, 25), 25)
  assert.equal(bucketFor(50, 25), 50)
  assert.equal(bucketFor(99, 25), 50)
  assert.equal(bucketFor(100, 25), 100)
  assert.equal(bucketFor(10_000, 25), 100)
})

test('hintKeyFor pins the documented latch key', () => {
  assert.equal(hintKeyFor('T7', 25), 'T7:25')
  assert.equal(hintKeyFor('T12', 100), 'T12:100')
})

test('a configured threshold publishes its own buckets at 1x, 2x and 4x', async () => {
  const { sim, h } = await openTask({ settings: { staleTaskSteps: 5 } })
  say(sim, 4)
  assert.equal(keyOf(sim, h), null)
  say(sim, 1) // age 5: the first bucket
  assert.equal(keyOf(sim, h), 'T1:5')
  say(sim, 4) // age 9: still inside the first bucket
  assert.equal(keyOf(sim, h), 'T1:5')
  say(sim, 1) // age 10
  assert.equal(keyOf(sim, h), 'T1:10')
  say(sim, 9) // age 19
  assert.equal(keyOf(sim, h), 'T1:10')
  say(sim, 1) // age 20
  assert.equal(keyOf(sim, h), 'T1:20')
  say(sim, 80) // age 100: the last bucket is a ceiling
  assert.equal(keyOf(sim, h), 'T1:20')
})

test('the default threshold maps to the documented 25, 50 and 100 buckets', async () => {
  const { sim, h } = await openTask()
  assert.equal(h.settings.staleTaskSteps, 25)
  say(sim, 24)
  assert.equal(keyOf(sim, h), null)
  say(sim, 1) // age 25
  assert.equal(keyOf(sim, h), 'T1:25')
  say(sim, 24) // age 49
  assert.equal(keyOf(sim, h), 'T1:25')
  say(sim, 1) // age 50
  assert.equal(keyOf(sim, h), 'T1:50')
  say(sim, 49) // age 99
  assert.equal(keyOf(sim, h), 'T1:50')
  say(sim, 1) // age 100
  assert.equal(keyOf(sim, h), 'T1:100')
  say(sim, 900) // age 1000: nothing beyond the last bucket
  assert.equal(keyOf(sim, h), 'T1:100')
})

// ---------------------------------------------------------------------------
// Which task, and what the message looks like

test('the innermost open task is the one the hint names', async () => {
  const sim = new Sim()
  const h = harnessOf(sim)
  await h.batch([{ name: 'task_begin', args: { title: 'outer' } }])
  await h.batch([{ name: 'task_begin', args: { title: 'inner' } }])
  say(sim, 25)
  assert.deepEqual(sim.state.open, ['T1', 'T2'])
  // Both are stale (ages 26 and 25); the model is working inside T2.
  const hint = maybeHint(sim.state, h.settings)
  assert.equal(hint?.key, 'T2:25')
  assert.match(textOf(hint), /^Task T2 "inner" has been open for 25\+ steps\./)
})

test('the hint message carries the task, the bucket and the latch key', async () => {
  const { sim, h } = await openTask({ title: 'Fix login redirect loop' })
  say(sim, 25)
  const hint = maybeHint(sim.state, h.settings)
  assert.ok(hint)
  assert.equal(hint.key, 'T1:25')
  assert.equal(hint.message.role, 'user')
  assert.equal(hint.message.source.kind, 'task-folding:hint')
  assert.deepEqual(hint.message.source, { kind: 'task-folding:hint', key: 'T1:25' })
  assert.deepEqual(hint.message.content, [
    { type: 'text', text: texts.renderStaleTaskHint('T1', 'Fix login redirect loop', 25) },
  ])
  // docs/04 §5, verbatim: the text is the contract, not a template to improve later.
  assert.equal(
    textOf(hint),
    'Task T1 "Fix login redirect loop" has been open for 25+ steps. If it is finished, call task_end with a summary; if it has distinct parts, wrap the remaining parts in nested tasks.',
  )
})

test('the hint text names the bucket and nothing else about the age', () => {
  assert.equal(
    texts.renderStaleTaskHint('T7', 'Review PR #98', 25),
    'Task T7 "Review PR #98" has been open for 25+ steps. If it is finished, call task_end with a summary; if it has distinct parts, wrap the remaining parts in nested tasks.',
  )
  assert.equal(
    texts.renderStaleTaskHint('T7', 'Review PR #98', 100),
    'Task T7 "Review PR #98" has been open for 100+ steps. If it is finished, call task_end with a summary; if it has distinct parts, wrap the remaining parts in nested tasks.',
  )
  // A title with a double quote stays one line and keeps the quoted title balanced.
  assert.ok(
    texts
      .renderStaleTaskHint('T1', 'Fix "odd" title', 25)
      .startsWith('Task T1 "Fix \\"odd\\" title" has been open for 25+ steps.'),
  )
})

// ---------------------------------------------------------------------------
// The durable latch

test('the durable latch suppresses a published key only', async () => {
  const { sim, h } = await openTask()
  say(sim, 25)
  const hint = maybeHint(sim.state, h.settings)
  assert.ok(hint)
  // The projection sets `hintKey` when the host logs the message; the same key is not published twice.
  assert.equal(maybeHint({ ...sim.state, hintKey: hint.key }, h.settings), null)
  // Another task's key does not latch this task's hint.
  assert.deepEqual(maybeHint({ ...sim.state, hintKey: 'T9:25' }, h.settings), hint)
  // A higher bucket is a new key and publishes again.
  say(sim, 25)
  const raised = maybeHint({ ...sim.state, hintKey: 'T1:25' }, h.settings)
  assert.equal(raised?.key, 'T1:50')
  assert.equal(maybeHint({ ...sim.state, hintKey: 'T1:50' }, h.settings), null)
})

// ---------------------------------------------------------------------------
// Byte stability

test('the text is byte-stable while the age stays inside a bucket', async () => {
  const { sim, h } = await openTask()
  say(sim, 25)
  const first = maybeHint(sim.state, h.settings)
  const second = maybeHint(sim.state, h.settings)
  assert.ok(first && second)
  assert.equal(textOf(second), textOf(first), 'the same state yields the same bytes')
  say(sim, 5) // age 30: the exact age is not in the text
  const later = maybeHint(sim.state, h.settings)
  assert.ok(later)
  assert.equal(textOf(later), textOf(first))
  say(sim, 20) // age 50: the next bucket changes only the number
  const next = maybeHint(sim.state, h.settings)
  assert.ok(next)
  assert.notEqual(textOf(next), textOf(first))
  assert.match(textOf(next), /50\+ steps/)
})

// ---------------------------------------------------------------------------
// Purity

test('hints imports only the projection constant and the texts, and mutates nothing', async () => {
  const source = readFileSync(new URL('../host/hints.js', import.meta.url), 'utf8')
  assert.deepEqual(source.match(/^import .*$/gm), [
    "import { HINT_SOURCE_KIND } from './projection.js'",
    "import * as texts from './texts.js'",
  ])
  for (const forbidden of [
    'node:fs',
    "from 'fs'",
    'node:child_process',
    'Date.now',
    'Math.random',
    'process.',
    'snapshotEvents',
    'writeFile',
  ])
    assert.equal(source.includes(forbidden), false, `host/hints.js must not mention ${forbidden}`)

  const { sim, h } = await openTask()
  say(sim, 25)
  const before = JSON.stringify(sim.state)
  const state = /** @type {State} */ (deepFreeze(JSON.parse(before)))
  const settings = /** @type {Settings} */ (deepFreeze({ ...h.settings }))
  const hint = maybeHint(state, settings)
  assert.equal(hint?.key, 'T1:25')
  assert.equal(JSON.stringify(state), before, 'no read mutates the state')
})
