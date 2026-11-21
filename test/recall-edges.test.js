// fold_recall argument edges and output caps (docs/03 §6.3, docs/04 §1, docs/09 T4). Every read
// goes through the real exported recall functions; the smallest pieces of test/recall.test.js are
// copied here (`taskWithMessages`/`taskWithUsers` build on the shared `Sim` and `harnessOf`
// fixtures), and the degraded-index session is a local fake because no live session derives no
// message for a surface event.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { initialState } from '../host/projection.js'
import * as texts from '../host/texts.js'
import {
  GREP_CONTEXT_CHARS,
  GREP_MAX_HITS,
  INDEX_PAGE_LINES,
  RANGE_MAX_CHARS,
  RANGE_MAX_MESSAGES,
  briefOfSeq,
  foldGrep,
  foldIndex,
  foldOrdinalForTask,
  foldRange,
  listFolds,
  resolveFold,
} from '../host/recall.js'
import { Sim } from './fixtures/sim.js'
import { fakeMeter, harnessOf } from './fixtures/tools.js'

/** @typedef {import('../host/types.js').State} State */
/** @typedef {{ eventAt(seq: number): any, deriveEventMessage(event: any): any }} RecallSessionLike */

/** A summary that clears the tool verdict, so `sim.fold` has a task to fold. */
const SUMMARY = `## Done\n${'Summarized the edges with the paths and the values that matter. '.repeat(4)}`

/**
 * One task with one plain user message per entry, folded once. The fold shadows the messages in
 * order, so `L1` is the first entry and the header names the task `T1 · edges`.
 *
 * @param {string[]} messages
 */
async function taskWithMessages(messages) {
  const sim = new Sim()
  const h = harnessOf(sim, { meter: fakeMeter() })
  await h.batch([{ name: 'task_begin', args: { title: 'edges' } }])
  for (const text of messages) sim.user(text)
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])
  sim.fold('T1')
  const row = sim.state.folds[0]
  assert.ok(row)
  return { sim, h, row }
}

/**
 * `count` plain user messages: the fold shadows `count + 2` nodes (the end batch's assistant
 * message and its result). Used for the index page boundary.
 *
 * @param {number} count
 */
async function taskWithUsers(count) {
  return taskWithMessages(Array.from({ length: count }, (_, i) => `u${i}`))
}

/**
 * Call `foldRange` with values the TypeScript signature does not allow, the way a host can hand
 * them over before the tool layer validates them.
 *
 * @param {State} state
 * @param {RecallSessionLike} session
 * @param {number} ordinal
 * @param {any} from
 * @param {any} to
 */
function rangeOf(state, session, ordinal, from, to) {
  return foldRange(state, session, ordinal, from, to)
}

// ---------------------------------------------------------------------------
// A session without folds, and fold numbers that do not exist

test('no arguments on a session without folds answers the documented empty list', async () => {
  const sim = new Sim()
  const h = harnessOf(sim, { meter: fakeMeter() })

  assert.equal(listFolds(initialState(), h.session), 'No folds yet.')
  // The tool dispatch is the caller the model uses; it returns the same text, not a throw.
  const call = await h.call('fold_recall', {})
  assert.equal(call.text, 'No folds yet.')
  assert.equal(call.value.text, texts.renderFoldList([]))
  assert.equal(call.meta, undefined, 'recall writes no meta')

  // Every reader refuses to invent a fold: the same "no folds" text for index, range and grep.
  assert.equal(foldIndex(initialState(), h.session, 1), texts.NOT_FOUND_FOLD(1, 0))
  assert.equal(rangeOf(initialState(), h.session, 1, 1, 1), texts.NOT_FOUND_FOLD(1, 0))
  assert.equal(foldGrep(initialState(), h.session, 1, 'x'), texts.NOT_FOUND_FOLD(1, 0))
  assert.equal(texts.NOT_FOUND_FOLD(1, 0), 'no folds yet.')
})

test('unknown, malformed and negative fold numbers are clean text, not a throw', async () => {
  const { sim, h } = await taskWithMessages(['one', 'two', 'three'])
  const total = sim.state.folds.length
  assert.equal(total, 1)

  for (const ordinal of [0, -1, 2, 1.5, Number.NaN]) {
    assert.equal(resolveFold(sim.state, h.session, ordinal), null, `resolveFold(${ordinal})`)
    assert.equal(foldIndex(sim.state, h.session, ordinal), texts.NOT_FOUND_FOLD(ordinal, total))
    assert.equal(foldGrep(sim.state, h.session, ordinal, 'x'), texts.NOT_FOUND_FOLD(ordinal, total))
    assert.equal(rangeOf(sim.state, h.session, ordinal, 1, 1), texts.NOT_FOUND_FOLD(ordinal, total))
  }
  assert.equal(foldIndex(sim.state, h.session, -1), 'fold #-1 does not exist; this session has 1 fold.')
  // A valid number resolves; the read itself works.
  assert.ok(resolveFold(sim.state, h.session, 1))
  assert.match(foldIndex(sim.state, h.session, 1), /^Fold #1 · T1 · edges · 5 messages\n/)
})

test('a task id that does not exist or is malformed resolves to null, and the tool says so', async () => {
  const { sim, h } = await taskWithMessages(['one', 'two', 'three'])
  for (const taskId of ['T9', 'T2', 'T0', 'T1x', 't1', '']) {
    assert.equal(foldOrdinalForTask(sim.state, taskId), null, `foldOrdinalForTask(${JSON.stringify(taskId)})`)
  }
  assert.equal(foldOrdinalForTask(sim.state, 'T1'), 1)
  const call = (/** @type {Record<string, unknown>} */ args) => h.call('fold_recall', args)
  assert.equal((await call({ task: 'T9' })).text, texts.NOT_FOUND_TASK('T9'))
  assert.equal((await call({ task: 7 })).text, texts.BAD_TASK_ARG(7), 'a non-string id is refused')
  assert.equal((await call({ fold: 'one' })).text, texts.BAD_FOLD_ARG('one'))
  assert.equal((await call({ fold: -1 })).text, texts.NOT_FOUND_FOLD(-1, 1))
  assert.equal((await call({ fold: 0 })).text, texts.NOT_FOUND_FOLD(0, 1))
})

// ---------------------------------------------------------------------------
// The exact range's argument edges

test('from and to come together, in order, and inside the fold', async () => {
  const { sim, h, row } = await taskWithMessages(['one', 'two', 'three'])
  const total = row.shadowedCount
  assert.equal(total, 5)

  assert.equal(rangeOf(sim.state, h.session, 1, 1, undefined), texts.RANGE_NEEDS_BOTH)
  assert.equal(rangeOf(sim.state, h.session, 1, undefined, 2), texts.RANGE_NEEDS_BOTH)
  assert.equal(rangeOf(sim.state, h.session, 1, undefined, undefined), texts.RANGE_NEEDS_BOTH)
  assert.equal(rangeOf(sim.state, h.session, 1, 1.5, 2), texts.RANGE_NEEDS_BOTH)
  assert.equal(rangeOf(sim.state, h.session, 1, 1, Number.NaN), texts.RANGE_NEEDS_BOTH)
  assert.equal(rangeOf(sim.state, h.session, 1, '1', 2), texts.RANGE_NEEDS_BOTH)

  // The order check runs before the bounds check: 1..0 is "backwards", not "outside".
  assert.equal(rangeOf(sim.state, h.session, 1, 5, 3), texts.RANGE_BACKWARDS(5, 3))
  assert.equal(rangeOf(sim.state, h.session, 1, 1, 0), texts.RANGE_BACKWARDS(1, 0))
  assert.equal(rangeOf(sim.state, h.session, 1, 6, 7), texts.RANGE_OUT_OF_BOUNDS(6, 7, total))
  assert.equal(rangeOf(sim.state, h.session, 1, -1, 2), texts.RANGE_OUT_OF_BOUNDS(-1, 2, total))
  assert.equal(rangeOf(sim.state, h.session, 1, 0, 2), texts.RANGE_OUT_OF_BOUNDS(0, 2, total))
  assert.equal(rangeOf(sim.state, h.session, 1, -2, -1), texts.RANGE_OUT_OF_BOUNDS(-2, -1, total))

  // `to` past the end is clamped to the last message; the header says what was actually read.
  const clamped = rangeOf(sim.state, h.session, 1, 1, total + 5).split('\n')
  assert.equal(clamped[0], `Fold #1 lines 1-${total}:`)
  assert.equal(clamped.length - 1, total)
  const onePast = rangeOf(sim.state, h.session, 1, total + 1, total + 1)
  assert.equal(onePast, texts.RANGE_OUT_OF_BOUNDS(total + 1, total + 1, total))
})

test('the tool dispatch refuses a partial range and a range next to grep', async () => {
  const { sim, h } = await taskWithMessages(['one', 'two', 'three'])
  const call = (/** @type {Record<string, unknown>} */ args) => h.call('fold_recall', args)
  assert.equal((await call({ from: 1 })).text, texts.NEED_FOLD, 'from alone names no fold')
  assert.equal((await call({ to: 2 })).text, texts.NEED_FOLD)
  assert.equal((await call({ fold: 1, from: 1 })).text, texts.RANGE_NEEDS_BOTH)
  assert.equal((await call({ fold: 1, to: 2 })).text, texts.RANGE_NEEDS_BOTH)
  assert.equal((await call({ fold: 1, from: 1, to: 2, grep: 'x' })).text, texts.RANGE_OR_GREP)
  assert.equal(sim.state.folds.length, 1, 'a refused read folds nothing')
})

// ---------------------------------------------------------------------------
// Caps: the index page

test('the index pages at exactly INDEX_PAGE_LINES and one line past it', async () => {
  const boundary = await taskWithUsers(INDEX_PAGE_LINES - 2)
  const row = boundary.row
  assert.equal(row.shadowedCount, INDEX_PAGE_LINES)

  const page = foldIndex(boundary.sim.state, boundary.h.session, 1).split('\n')
  assert.equal(page[0], `Fold #1 · T1 · edges · ${INDEX_PAGE_LINES} messages`)
  assert.equal(page.length - 1, INDEX_PAGE_LINES, 'one line per shadowed message')
  assert.match(member(page, INDEX_PAGE_LINES), new RegExp(`^L${INDEX_PAGE_LINES} `))
  assert.equal(
    foldIndex(boundary.sim.state, boundary.h.session, 1, 2),
    texts.PAGE_NOT_FOUND(2, INDEX_PAGE_LINES, 1),
    'there is no second page at the boundary',
  )

  const past = await taskWithUsers(INDEX_PAGE_LINES - 1)
  assert.equal(past.row.shadowedCount, INDEX_PAGE_LINES + 1)
  const first = foldIndex(past.sim.state, past.h.session, 1).split('\n')
  assert.equal(first[0], `Fold #1 · T1 · edges · ${INDEX_PAGE_LINES + 1} messages (page 1 of 2)`)
  assert.equal(first.length - 1, INDEX_PAGE_LINES)
  const second = foldIndex(past.sim.state, past.h.session, 1, 2).split('\n')
  assert.equal(second[0], `Fold #1 · T1 · edges · ${INDEX_PAGE_LINES + 1} messages (page 2 of 2)`)
  assert.equal(second.length, 2, 'the header and the one message that did not fit page one')
  assert.match(member(second, 1), new RegExp(`^L${INDEX_PAGE_LINES + 1} `))
  assert.equal(
    foldIndex(past.sim.state, past.h.session, 1, 3),
    texts.PAGE_NOT_FOUND(3, INDEX_PAGE_LINES + 1, 2),
  )
})

test('a page number that is not a positive integer is refused before paging', async () => {
  const { sim, h, row } = await taskWithMessages(['one', 'two', 'three'])
  for (const page of /** @type {any[]} */ ([0, -1, 1.5, '2', Number.NaN])) {
    assert.equal(foldIndex(sim.state, h.session, 1, page), texts.PAGE_INVALID(page))
  }
  assert.equal(texts.PAGE_INVALID(0), 'page must be a number of 1 or more, not 0.')
  // The tool layer rejects the same values before they reach recall.
  const h2 = harnessOf(sim, { meter: fakeMeter() })
  assert.equal((await h2.call('fold_recall', { fold: 1, page: 0 })).text, texts.PAGE_INVALID(0))
  assert.equal(row.shadowedCount, 5)
})

// ---------------------------------------------------------------------------
// Caps: the exact range

test('a range of exactly RANGE_MAX_MESSAGES is returned whole, one more is truncated', async () => {
  const { sim, h } = await taskWithMessages(Array.from({ length: RANGE_MAX_MESSAGES + 5 }, (_, i) => `m${i}`))
  const atCap = foldRange(sim.state, h.session, 1, 1, RANGE_MAX_MESSAGES).split('\n')
  assert.equal(atCap[0], `Fold #1 lines 1-${RANGE_MAX_MESSAGES}:`)
  assert.equal(atCap.length - 1, RANGE_MAX_MESSAGES, 'every requested message is present')
  assert.notEqual(atCap.at(-1), texts.RANGE_TRUNCATED, 'no marker at the boundary')

  const past = foldRange(sim.state, h.session, 1, 1, RANGE_MAX_MESSAGES + 1).split('\n')
  assert.equal(past[0], `Fold #1 lines 1-${RANGE_MAX_MESSAGES}:`, 'the header names what was read')
  assert.equal(past.length - 1, RANGE_MAX_MESSAGES + 1, 'the message lines and the marker')
  assert.equal(past.at(-1), texts.RANGE_TRUNCATED)
})

test('a range of exactly RANGE_MAX_CHARS is returned whole, one character more is truncated', async () => {
  // Two user messages: `renderRangeLine` is `L<n> ` plus the message's JSON, and the constant
  // JSON overhead of these two messages is equal, so the padding below puts the sum exactly on the
  // cap. The test computes the rendered lines instead of hard-coding the character count.
  const boundary = await taskWithMessages(['a'.repeat(36), 'b'.repeat(39_800)])
  const seqs = shadowedSeqsOf(boundary.h.session, boundary.row)
  const first = texts.renderRangeLine(1, messageOf(boundary.h.session, member(seqs, 0)))
  const second = texts.renderRangeLine(2, messageOf(boundary.h.session, member(seqs, 1)))
  assert.equal(first.length + 1 + second.length + 1, RANGE_MAX_CHARS, 'the fixture sits on the cap')

  const atCap = foldRange(boundary.sim.state, boundary.h.session, 1, 1, 2).split('\n')
  assert.equal(atCap[0], 'Fold #1 lines 1-2:')
  assert.equal(atCap.length, 3, 'the header and both messages, no marker')
  assert.equal(
    atCap.slice(1).reduce((used, line) => used + line.length + 1, 0),
    RANGE_MAX_CHARS,
    'both messages fit exactly',
  )

  const past = await taskWithMessages(['a'.repeat(36), 'b'.repeat(39_801)])
  const pastSeqs = shadowedSeqsOf(past.h.session, past.row)
  const pastFirst = texts.renderRangeLine(1, messageOf(past.h.session, member(pastSeqs, 0)))
  const pastSecond = texts.renderRangeLine(2, messageOf(past.h.session, member(pastSeqs, 1)))
  assert.equal(pastFirst.length + 1 + pastSecond.length + 1, RANGE_MAX_CHARS + 1)
  const truncated = foldRange(past.sim.state, past.h.session, 1, 1, 2).split('\n')
  assert.equal(truncated[0], 'Fold #1 lines 1-1:', 'the second message is dropped whole')
  assert.equal(truncated.length, 3)
  assert.equal(truncated.at(-1), texts.RANGE_TRUNCATED)
  assert.equal(truncated[1], pastFirst, 'the first message is intact')
})

// ---------------------------------------------------------------------------
// Caps: grep hits and context

test('grep caps at GREP_MAX_HITS and says how many hits it cut', async () => {
  const atCap = await taskWithMessages(Array.from({ length: GREP_MAX_HITS }, (_, i) => `needle ${i}`))
  const boundary = foldGrep(atCap.sim.state, atCap.h.session, 1, 'needle').split('\n')
  assert.equal(boundary[0], texts.renderGrepHeader(1, 'needle', GREP_MAX_HITS))
  assert.equal(boundary.length - 1, GREP_MAX_HITS, 'one hit line per message')
  assert.notEqual(boundary.at(-1), texts.GREP_TRUNCATED(GREP_MAX_HITS, GREP_MAX_HITS))

  const past = await taskWithMessages(Array.from({ length: GREP_MAX_HITS + 1 }, (_, i) => `needle ${i}`))
  const truncated = foldGrep(past.sim.state, past.h.session, 1, 'needle').split('\n')
  assert.equal(truncated[0], texts.renderGrepHeader(1, 'needle', GREP_MAX_HITS + 1))
  assert.equal(truncated.length - 2, GREP_MAX_HITS, 'the hit lines stay capped')
  assert.equal(truncated.at(-1), texts.GREP_TRUNCATED(GREP_MAX_HITS, GREP_MAX_HITS + 1))
})

test('grep keeps a match longer than GREP_CONTEXT_CHARS to exactly the cap', async () => {
  const under = 'm'.repeat(GREP_CONTEXT_CHARS - 1)
  const atCap = 'n'.repeat(GREP_CONTEXT_CHARS)
  const past = 'o'.repeat(GREP_CONTEXT_CHARS + 1)
  const alone = 'p'.repeat(GREP_CONTEXT_CHARS)
  const { sim, h } = await taskWithMessages([
    `abc ${under} xyz`,
    `abc ${atCap} xyz`,
    `abc ${past} xyz`,
    alone,
  ])

  // One character under the cap: the whole match is inside the context window.
  assert.equal(singleHit(foldGrep(sim.state, h.session, 1, under)), `L1: …${under}…`)
  // At the cap the branch returns the match itself, bounded by two ellipses.
  assert.equal(singleHit(foldGrep(sim.state, h.session, 1, atCap)), `L2: …${atCap}…`)
  // One character past it the context is cut at the cap, never longer.
  const cut = singleHit(foldGrep(sim.state, h.session, 1, past))
  assert.equal(cut, `L3: …${past.slice(0, GREP_CONTEXT_CHARS)}…`)
  assert.equal(contextLength(cut), GREP_CONTEXT_CHARS)
  // A match at the start of the message has no leading ellipsis, but still gets the trailing one.
  assert.equal(singleHit(foldGrep(sim.state, h.session, 1, alone)), `L4: ${alone}…`)
})

test('grep treats a regex-like query as literal text unless it is a complete /regex/', async () => {
  const { sim, h } = await taskWithMessages(['axb value', 'a.b value', '/needle value', 'NEEDLE upper'])

  const dot = foldGrep(sim.state, h.session, 1, 'a.b').split('\n')
  assert.equal(dot[0], texts.renderGrepHeader(1, 'a.b', 1), 'the dot is not a wildcard')
  assert.equal(dot[1], 'L2: a.b value')

  const slash = foldGrep(sim.state, h.session, 1, '/needle').split('\n')
  assert.equal(slash[0], texts.renderGrepHeader(1, '/needle', 1), 'an unterminated slash form is literal')
  assert.equal(slash[1], 'L3: /needle value')

  const insensitive = foldGrep(sim.state, h.session, 1, 'needle').split('\n')
  assert.equal(insensitive[0], texts.renderGrepHeader(1, 'needle', 2), 'plain text is case-insensitive')

  assert.equal(foldGrep(sim.state, h.session, 1, 'a+'), texts.renderGrepEmpty(1, 'a+'))
})

test('grep refuses an empty, whitespace-only or invalid pattern as text', async () => {
  const { sim, h } = await taskWithMessages(['anything'])
  assert.equal(foldGrep(sim.state, h.session, 1, ''), texts.GREP_EMPTY)
  assert.equal(foldGrep(sim.state, h.session, 1, '   '), texts.GREP_EMPTY)
  assert.equal(foldGrep(sim.state, h.session, 1, '\t\n '), texts.GREP_EMPTY)
  assert.equal(foldGrep(sim.state, h.session, 1, '//'), texts.BAD_REGEX('//', texts.ERR_EMPTY_REGEX))
  assert.match(foldGrep(sim.state, h.session, 1, '/[/'), /^bad regex "\/\[\/": /)
})

// ---------------------------------------------------------------------------
// Messages with binary payloads

test('a range projects a binary tool result to bounded JSON text', async () => {
  const sim = new Sim()
  const h = harnessOf(sim, { meter: fakeMeter() })
  await h.batch([{ name: 'task_begin', args: { title: 'binary' } }])
  sim.user('before binary')
  const bytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256))
  const base64 = 'A'.repeat(60_000)
  sim.push({
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        toolCallId: 'call_binary',
        source: { kind: 'tool', callId: 'call_binary' },
        content: [
          { type: 'text', text: 'binary result' },
          { type: 'image', attachment: { id: 'attachment-1', mediaType: 'image/png', bytes: 4096 } },
          { type: 'data', data: bytes, base64 },
        ],
      },
    },
    surfaceOp: 'append',
  })
  sim.user('after binary')
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])
  sim.fold('T1')

  // The binary message alone is indivisible, so the reader returns it whole: still text.
  const whole = foldRange(sim.state, h.session, 1, 2, 2)
  assert.equal(typeof whole, 'string')
  const wholeLine = member(whole.split('\n'), 1)
  assert.ok(wholeLine.length > RANGE_MAX_CHARS, 'a single message is never split (docs/04 §1)')
  const parsed = JSON.parse(wholeLine.slice(wholeLine.indexOf(' ') + 1))
  assert.equal(parsed.content[1].type, 'image', 'the attachment reference survives as JSON')
  assert.equal(parsed.content[2].base64, base64, 'the base64 payload round-trips exactly')
  // A Buffer is not a JSON value: the projection is textual (`{type:'Buffer', data:[…]}`), not bytes.
  assert.equal(parsed.content[2].data.type, 'Buffer')
  assert.equal(parsed.content[2].data.data.length, bytes.length)

  // Across messages the cap drops the binary message whole instead of cutting into it.
  const capped = foldRange(sim.state, h.session, 1, 1, 3).split('\n')
  assert.equal(capped[0], 'Fold #1 lines 1-1:', 'the small first message is all that fits')
  assert.equal(capped.at(-1), texts.RANGE_TRUNCATED)
  assert.equal(capped.length, 3)
  assert.equal(capped.includes(wholeLine), false, 'the payload is never emitted partially')
  assert.equal(foldRange(sim.state, h.session, 1, 1, 1).includes('binary result'), false)
})

// ---------------------------------------------------------------------------
// Degraded messages: the brief fallbacks (host/recall.js roleOf/toolNameOf, host/texts.js renderBrief)

test('a tool result still names its tool when the assistant message is not rendered', async () => {
  const sim = new Sim()
  const h = harnessOf(sim, { meter: fakeMeter() })
  await h.batch([{ name: 'task_begin', args: { title: 'edges' } }])
  sim.work(1) // a read call, made through the simulator so its `tool/call` carries the name
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])
  sim.fold('T1')
  const row = sim.state.folds[0]
  assert.ok(row)
  const resultSeq = member(shadowedSeqsOf(h.session, row), 1)
  const event = h.session.eventAt(resultSeq)
  assert.ok(event)
  assert.equal(event.type, 'tool/result')
  const callId = h.session.deriveEventMessage(event).toolCallId
  assert.equal(typeof callId, 'string')
  // The fallback reads the result's `tool/call` source event when the caller passes no name map.
  assert.equal(briefOfSeq(h.session, resultSeq), 'tool read: result')
  assert.equal(briefOfSeq(h.session, resultSeq, new Map([[callId, 'mapped']])), 'tool mapped: result')
})

test('an index of events that derive no message stays one readable line per message', async () => {
  // `session.deriveEventMessage` is documented to return `Message | null`; the degraded read is
  // covered through the public `foldIndex`, not by calling the private brief helpers.
  /** @type {Map<number, any>} */
  const events = new Map([
    [1, { type: 'user/message', seq: 1 }],
    [2, { type: 'system/message', seq: 2 }],
    [3, { type: 'assistant/message', seq: 3 }],
    [4, { type: 'tool/result', seq: 4 }],
    [5, { type: 'compaction/end', seq: 5 }],
    [100, { type: 'compaction/summary', seq: 100, data: { shadowedSeqs: [1, 2, 3, 4, 5] } }],
  ])
  /** @type {RecallSessionLike} */
  const session = {
    eventAt: (seq) => events.get(seq),
    deriveEventMessage: () => null,
  }
  const state = initialState()
  state.folds.push({
    summarySeq: 100,
    nodeSeq: null,
    taskId: 'T1',
    shadowedCount: 5,
    shadowedTokens: 500,
  })
  state.tasks.T1 = /** @type {any} */ ({ title: 'degraded' })

  assert.deepEqual(foldIndex(state, session, 1).split('\n'), [
    'Fold #1 · T1 · degraded · 5 messages',
    'L1 user: (empty)',
    'L2 system: (empty)',
    'L3 assistant: (empty)',
    'L4 tool: (empty)',
    'L5 message: (empty)',
  ])
  // The same degraded event through the other caller of the brief renderer.
  assert.equal(briefOfSeq(session, 5), 'message: (empty)')
  // A range still serializes the null-derived message as JSON `null` rather than throwing.
  assert.equal(rangeOf(state, session, 1, 1, 1).split('\n')[1], 'L1 null')
})

// ---------------------------------------------------------------------------
// Helpers

/**
 * The `L<N>` line a single-hit grep produced.
 *
 * @param {string} output
 */
function singleHit(output) {
  const lines = output.split('\n')
  assert.equal(lines.length, 2, 'one header and one hit')
  return member(lines, 1)
}

/**
 * The context without its ellipsis markers.
 *
 * @param {string} hitLine
 */
function contextLength(hitLine) {
  return hitLine.slice(hitLine.indexOf(': ') + 2).replace(/^…|…$/g, '').length
}

/**
 * @template T
 * @param {readonly T[]} list
 * @param {number} index
 * @returns {T}
 */
function member(list, index) {
  const value = list[index]
  if (value === undefined) throw new Error(`no element ${index}`)
  return value
}

/**
 * The seqs a fold shadowed, in surface order.
 *
 * @param {{ eventAt(seq: number): any }} session
 * @param {import('../host/types.js').FoldRow} row
 * @returns {number[]}
 */
function shadowedSeqsOf(session, row) {
  const event = session.eventAt(row.summarySeq)
  const seqs = event && event.data ? event.data.shadowedSeqs : undefined
  assert.ok(Array.isArray(seqs))
  return seqs
}

/**
 * The host message a surface seq derives.
 *
 * @param {{ eventAt(seq: number): any, deriveEventMessage(event: any): any }} session
 * @param {number} seq
 */
function messageOf(session, seq) {
  return session.deriveEventMessage(session.eventAt(seq))
}
