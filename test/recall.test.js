// fold_recall reads (docs/03 §6.3, docs/04 §1): the fold tree, the paged span index, exact
// ranges, grep, and the invariant that recall returns deriveEventMessage of the shadowed seqs.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply, initialState } from '../host/domain/projection.js'
import * as texts from '../host/domain/texts.js'
import {
  GREP_CONTEXT_CHARS,
  GREP_MAX_HITS,
  INDEX_PAGE_LINES,
  RANGE_MAX_CHARS,
  RANGE_MAX_MESSAGES,
  foldGrep,
  foldIndex,
  foldOrdinalForTask,
  foldRange,
  listFolds,
  resolveFold,
} from '../host/tools/recall.js'
import { journalEvents, readJournalText } from '../scripts/journal.js'
import { M2_LOGS } from './fixtures/journals.js'
import { Sim } from './fixtures/sim.js'
import { fakeMeter, harnessOf } from './fixtures/tools.js'

/** @typedef {import('../host/domain/types.js').SessionEvent} SessionEvent */
/** @typedef {import('../host/domain/types.js').State} State */

/** A summary that clears minSummaryChars without being large. */
const SUMMARY = `## Done\n${'Wired the tool layer and checked it against the simulator. '.repeat(5)}`

function harness() {
  const sim = new Sim()
  return { sim, h: harnessOf(sim, { meter: fakeMeter() }) }
}

/**
 * An auto compaction, then an outer and an inner task; the inner folds first, so the outer fold
 * shadows the inner fold's node and the inner fold nests under it.
 */
async function nestedFolds() {
  const { sim, h } = harness()
  sim.user('earlier work')
  sim.work(1)
  assert.ok(sim.compactHead(3) !== null, 'the auto compaction committed')
  await h.batch([{ name: 'task_begin', args: { title: 'outer' } }])
  await h.batch([{ name: 'task_begin', args: { title: 'inner' } }])
  sim.work(3)
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])
  sim.work(2)
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])
  sim.fold('T2')
  sim.fold('T1')
  return { sim, h }
}

/** One task with 105 work steps: its fold shadows 212 messages, so the index has two pages. */
async function longFold() {
  const { sim, h } = harness()
  await h.batch([{ name: 'task_begin', args: { title: 'long' } }])
  sim.work(105)
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])
  sim.fold('T1')
  return { sim, h }
}

/** Twelve 3.5k-character messages: a 12-message range cannot fit the character budget. */
async function wideFold() {
  const { sim, h } = harness()
  await h.batch([{ name: 'task_begin', args: { title: 'wide' } }])
  for (let i = 0; i < 12; i++) sim.user(`${'x'.repeat(3500)} needle ${i}`)
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])
  sim.fold('T1')
  return { sim, h }
}

// ---------------------------------------------------------------------------
// The fold tree

test('the list nests a fold under the fold that shadowed it', async () => {
  const { sim, h } = await nestedFolds()
  assert.equal(
    listFolds(sim.state, h.session),
    [
      'Folds (3):',
      '#1 auto compaction · 3 msgs · ~300 tokens',
      '#3 T1 · outer · 9 msgs · ~900 tokens',
      '  #2 T2 · inner · 8 msgs · ~800 tokens',
    ].join('\n'),
  )
})

test('the list is empty before any fold', async () => {
  const { h } = harness()
  assert.equal(listFolds(initialState(), h.session), 'No folds yet.')
})

test('an auto compaction inside a task span nests under that fold', async () => {
  const { sim, h } = harness()
  await h.batch([{ name: 'task_begin', args: { title: 'auto inside' } }])
  sim.work(1)
  sim.compact(/** @type {number} */ (sim.nodes[3]), /** @type {number} */ (sim.nodes[4]))
  sim.work(1)
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])
  sim.fold('T1')

  assert.equal(
    listFolds(sim.state, h.session),
    [
      'Folds (2):',
      '#2 T1 · auto inside · 5 msgs · ~500 tokens',
      '  #1 auto compaction · 2 msgs · ~200 tokens',
    ].join('\n'),
  )
  // The shadowed node of an automatic compaction has no task and says so.
  assert.equal(foldIndex(sim.state, h.session, 2).split('\n')[1], 'L1 [fold #1 auto compaction]')
})

test('a task id resolves to the fold its replacement produced', async () => {
  const { sim } = await nestedFolds()
  assert.equal(foldOrdinalForTask(sim.state, 'T1'), 3)
  assert.equal(foldOrdinalForTask(sim.state, 'T2'), 2)
  assert.equal(foldOrdinalForTask(sim.state, 'T9'), null)
})

// ---------------------------------------------------------------------------
// The span index

test('the index marks a shadowed fold node and keeps one line per message', async () => {
  const { sim, h } = await nestedFolds()
  const index = foldIndex(sim.state, h.session, 3)
  const [head, ...lines] = index.split('\n')
  assert.equal(head, 'Fold #3 · T1 · outer · 9 messages')
  assert.equal(lines.length, 9)
  for (const [i, line] of lines.entries()) assert.match(line, new RegExp(`^L${i + 1} \\S`))
  // The inner fold's replacement node is an ordinary user/message in the log.
  assert.equal(lines[2], 'L3 [fold #2 T2 "inner"]')
  assert.equal(lines[0], 'L1 assistant: thinking')
  assert.equal(lines[1], 'L2 tool task_begin: result')
})

test('the index pages at 200 lines', async () => {
  const { sim, h } = await longFold()
  const row = sim.state.folds[0]
  assert.ok(row)
  const total = row.shadowedCount
  assert.ok(total > INDEX_PAGE_LINES)

  const page1 = foldIndex(sim.state, h.session, 1).split('\n')
  assert.equal(page1[0], `Fold #1 · T1 · long · ${total} messages (page 1 of 2)`)
  assert.equal(page1.length - 1, INDEX_PAGE_LINES)
  assert.match(/** @type {string} */ (page1[1]), /^L1 /)

  const page2 = foldIndex(sim.state, h.session, 1, 2).split('\n')
  assert.equal(page2[0], `Fold #1 · T1 · long · ${total} messages (page 2 of 2)`)
  assert.equal(page2.length - 1, total - INDEX_PAGE_LINES)
  assert.match(/** @type {string} */ (page2[1]), new RegExp(`^L${INDEX_PAGE_LINES + 1} `))

  assert.equal(foldIndex(sim.state, h.session, 1, 3), texts.PAGE_NOT_FOUND(3, total, 2))
})

// ---------------------------------------------------------------------------
// The exact range

test('a range returns the exact messages deriveEventMessage yields', async () => {
  const { sim, h } = await nestedFolds()
  const resolved = resolveFold(sim.state, h.session, 3)
  assert.ok(resolved)
  const expected = resolved.shadowed.slice(0, 2).map((seq, i) => {
    const event = /** @type {SessionEvent} */ (h.session.eventAt(seq))
    return `L${i + 1} ${JSON.stringify(h.session.deriveEventMessage(event))}`
  })
  assert.equal(
    foldRange(sim.state, h.session, 3, 1, 2),
    [texts.renderRangeHeader(3, 1, 2), ...expected].join('\n'),
  )
})

test('a range caps at 20 messages', async () => {
  const { sim, h } = await longFold()
  const row = sim.state.folds[0]
  assert.ok(row)
  const lines = foldRange(sim.state, h.session, 1, 1, row.shadowedCount).split('\n')
  assert.equal(lines.at(-1), texts.RANGE_TRUNCATED)
  assert.equal(lines.length - 2, RANGE_MAX_MESSAGES)
  assert.match(/** @type {string} */ (lines[0]), /^Fold #1 lines 1-20:$/)
})

test('a range caps at about 40k characters, dropping whole messages only', async () => {
  const { sim, h } = await wideFold()
  const row = sim.state.folds[0]
  assert.ok(row)
  const lines = foldRange(sim.state, h.session, 1, 1, row.shadowedCount).split('\n')
  assert.equal(lines.at(-1), texts.RANGE_TRUNCATED)
  const body = lines.slice(1, -1)
  assert.ok(body.length > 0 && body.length < row.shadowedCount)
  const used = body.reduce((n, line) => n + line.length + 1, 0)
  assert.ok(used <= RANGE_MAX_CHARS, `${used} characters`)
  for (const [i, line] of body.entries()) assert.match(line, new RegExp(`^L${i + 1} \\{"role":`))
})

test('a single message is returned whole even when it exceeds the character budget', async () => {
  const { sim, h } = harness()
  await h.batch([{ name: 'task_begin', args: { title: 'huge' } }])
  sim.user('y'.repeat(50_000))
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])
  sim.fold('T1')
  const lines = foldRange(sim.state, h.session, 1, 1, 1).split('\n')
  assert.equal(lines.length, 2)
  assert.equal(lines[0], 'Fold #1 lines 1-1:')
  assert.ok(/** @type {string} */ (lines[1]).length > RANGE_MAX_CHARS)
  assert.ok(/** @type {string} */ (lines[1]).endsWith('}'))
})

test('a range reports bad bounds instead of throwing', async () => {
  const { sim, h } = await nestedFolds()
  // `to` past the end is clamped to the last message; `from` past the end is an error.
  assert.match(foldRange(sim.state, h.session, 1, 1, 9), /^Fold #1 lines 1-3:\n/)
  assert.equal(foldRange(sim.state, h.session, 1, 4, 5), texts.RANGE_OUT_OF_BOUNDS(4, 5, 3))
  assert.equal(foldRange(sim.state, h.session, 1, 5, 3), texts.RANGE_BACKWARDS(5, 3))
  assert.equal(foldRange(sim.state, h.session, 99, 1, 1), texts.NOT_FOUND_FOLD(99, 3))
})

// ---------------------------------------------------------------------------
// Grep

test('grep finds case-insensitive text and /regex/', async () => {
  const { sim, h } = await wideFold()
  const text = foldGrep(sim.state, h.session, 1, 'needle')
  const lines = text.split('\n')
  assert.equal(lines[0], 'Fold #1 grep "needle" (12 hits):')
  assert.equal(lines.length, 13)
  for (const line of lines.slice(1)) {
    assert.match(line, /^L\d+: /)
    assert.ok(line.length <= 4 + GREP_CONTEXT_CHARS + 2, `context grew: ${line.length}`)
  }

  assert.match(foldGrep(sim.state, h.session, 1, '/needle \\d+/'), /^Fold #1 grep .* \(12 hits\):$/m)
  assert.match(foldGrep(sim.state, h.session, 1, '/NEEDLE/i'), /\(12 hits\)/)
  // A regex is used as written: without /i it is case-sensitive.
  assert.match(foldGrep(sim.state, h.session, 1, '/NEEDLE/'), /: no hits\.$/)
  assert.equal(
    foldGrep(sim.state, h.session, 1, 'nothing-matches-this'),
    texts.renderGrepEmpty(1, 'nothing-matches-this'),
  )
})

test('grep caps at 50 hits and says so', async () => {
  const { sim, h } = harness()
  await h.batch([{ name: 'task_begin', args: { title: 'many hits' } }])
  for (let i = 0; i < 55; i++) sim.user(`needle ${i}`)
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])
  sim.fold('T1')
  const lines = foldGrep(sim.state, h.session, 1, 'needle').split('\n')
  assert.equal(lines[0], 'Fold #1 grep "needle" (55 hits):')
  assert.equal(lines.length - 2, GREP_MAX_HITS)
  assert.equal(lines.at(-1), texts.GREP_TRUNCATED(GREP_MAX_HITS, 55))
})

test('grep searches a message once and reports an invalid regex as text', async () => {
  const { sim, h } = harness()
  await h.batch([{ name: 'task_begin', args: { title: 'twice' } }])
  sim.user('needle and needle again')
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])
  sim.fold('T1')
  const one = foldGrep(sim.state, h.session, 1, 'needle')
  assert.equal(one, 'Fold #1 grep "needle" (1 hit):\nL1: needle and needle again')

  const bad = foldGrep(sim.state, h.session, 1, '/[/')
  assert.match(bad, /^bad regex "\/\[\/": /)
  assert.equal(foldGrep(sim.state, h.session, 1, '  '), texts.GREP_EMPTY)
  assert.equal(foldGrep(sim.state, h.session, 1, '//'), texts.BAD_REGEX('//', texts.ERR_EMPTY_REGEX))
})

test('a fold that contains a pruned result is read like any other', async () => {
  const { sim, h } = harness()
  await h.batch([{ name: 'task_begin', args: { title: 'pruned' } }])
  sim.work(2)
  const target = /** @type {number} */ (sim.nodes[4])
  assert.equal(sim.bySeq.get(target)?.type, 'tool/result')
  const replacement = sim.prune(target)
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])
  sim.fold('T1')

  assert.match(listFolds(sim.state, h.session), /^Folds \(1\):\n#1 T1 · pruned · 6 msgs /)
  const index = foldIndex(sim.state, h.session, 1).split('\n')
  assert.equal(index.length, 7)
  assert.equal(index[2], 'L2 tool read: result')
  // The pruner's replacement keeps the original message, so the range is unchanged by it.
  const row = sim.state.folds[0]
  assert.ok(row)
  const shadowed = /** @type {number[]} */ (sim.bySeq.get(row.summarySeq)?.data.shadowedSeqs)
  assert.ok(shadowed.includes(replacement), 'the replacement node is shadowed')
  assert.equal(
    foldRange(sim.state, h.session, 1, 2, 2).split('\n')[1],
    `L2 ${JSON.stringify(sim.bySeq.get(replacement)?.data.message)}`,
  )
})

// ---------------------------------------------------------------------------
// The tool dispatch

test('the tool picks the fold from task or fold and reports clean errors', async () => {
  const { h } = await nestedFolds()
  const call = (/** @type {Record<string, unknown>} */ args) => h.call('fold_recall', args)

  assert.equal(
    (await call({ task: 'T2' })).text,
    [
      'Fold #2 · T2 · inner · 8 messages',
      'L1 assistant: thinking',
      'L2 tool read: result',
      'L3 assistant: thinking',
      'L4 tool read: result',
      'L5 assistant: thinking',
      'L6 tool read: result',
      'L7 assistant: thinking',
      'L8 tool task_end: result',
    ].join('\n'),
  )
  assert.match((await call({ fold: 3 })).text, /^Fold #3 · T1 · outer · 9 messages\n/)
  assert.match((await call({})).text, /^Folds \(3\):/)
  assert.match((await call({ fold: 3, from: 1, to: 2 })).text, /^Fold #3 lines 1-2:\nL1 \{/)
  assert.match((await call({ fold: 3, from: 1, to: 2, grep: 'x' })).text, /use either from\/to or grep/)

  assert.equal((await call({ fold: 99 })).text, texts.NOT_FOUND_FOLD(99, 3))
  assert.equal((await call({ fold: 'one' })).text, texts.BAD_FOLD_ARG('one'))
  assert.equal((await call({ task: 'T9' })).text, texts.NOT_FOUND_TASK('T9'))
  assert.equal((await call({ task: 7 })).text, texts.BAD_TASK_ARG(7))
  assert.equal((await call({ grep: 'x' })).text, texts.NEED_FOLD)
  assert.equal((await call({ page: 2 })).text, texts.NEED_FOLD)
  assert.equal((await call({ fold: 1, from: 1 })).text, texts.RANGE_NEEDS_BOTH)
  assert.equal((await call({ fold: 1, grep: 5 })).text, texts.BAD_GREP_ARG(5))
  assert.equal((await call({ fold: 1, page: 'two' })).text, texts.PAGE_INVALID('two'))
  assert.equal((await call({ fold: 1, page: 2 })).text, texts.PAGE_NOT_FOUND(2, 3, 1))
  // Reading back writes no meta: the durable state channel is for the lifecycle tools.
  assert.equal((await call({ fold: 1 })).meta, undefined)
})

// ---------------------------------------------------------------------------
// A real session log

test('replaying a live log, the index and ranges return deriveEventMessage in order', () => {
  const events = journalEvents(readJournalText(join(M2_LOGS, 'm3-nested-relay.jsonl')))
  const state = events.reduce(apply, initialState())
  const session = journalSession(events)
  assert.match(listFolds(state, session), /^Folds \(2\):\n#1 T2 · inner · 8 msgs · ~12\.7k tokens\n/)

  const row = state.folds[0]
  assert.ok(row)
  const shadowedEvent = session.eventAt(row.summarySeq)
  const shadowed = /** @type {number[]} */ (shadowedEvent.data.shadowedSeqs)
  assert.equal(shadowed.length, row.shadowedCount)

  const index = foldIndex(state, session, 1).split('\n')
  assert.equal(index[0], 'Fold #1 · T2 · inner · 8 messages')
  assert.equal(index.length - 1, shadowed.length)
  /** @type {Record<string, string>} */
  const roleOf = {
    'user/message': 'user',
    'system/message': 'system',
    'assistant/message': 'assistant',
  }
  for (const [i, seq] of shadowed.entries()) {
    const event = /** @type {SessionEvent} */ (session.eventAt(seq))
    const line = /** @type {string} */ (index[i + 1])
    // A tool line names the tool instead of the role: `L2 tool read: 310 lines`.
    const prefix =
      event.type === 'tool/result' ? `^L${i + 1} tool \\S+: ` : `^L${i + 1} ${roleOf[event.type]}: `
    assert.match(line, new RegExp(prefix))
  }

  // Invariant 7 (docs/03 §12): every original comes back exactly as deriveEventMessage has it.
  for (const [i, seq] of shadowed.entries()) {
    const expected = JSON.stringify(session.deriveEventMessage(session.eventAt(seq)))
    assert.equal(foldRange(state, session, 1, i + 1, i + 1).split('\n')[1], `L${i + 1} ${expected}`)
  }
})

// ---------------------------------------------------------------------------
// Purity

test('recall imports nothing but texts and writes nothing', async () => {
  const source = readFileSync(new URL('../host/tools/recall.js', import.meta.url), 'utf8')
  assert.deepEqual(source.match(/^import .*$/gm), ["import * as texts from '../domain/texts.js'"])
  for (const forbidden of ['node:fs', "from 'fs'", 'node:child_process', 'snapshotEvents', 'writeFile'])
    assert.equal(source.includes(forbidden), false, `host/tools/recall.js must not mention ${forbidden}`)

  const { sim, h } = await nestedFolds()
  const frozen = deepFreeze(JSON.parse(JSON.stringify(sim.state)))
  const before = JSON.stringify(frozen)
  assert.match(listFolds(frozen, h.session), /^Folds \(3\):/)
  assert.match(foldIndex(frozen, h.session, 3), /^Fold #3 /)
  assert.match(foldRange(frozen, h.session, 3, 1, 1), /^Fold #3 lines 1-1:/)
  assert.match(foldGrep(frozen, h.session, 3, 'thinking'), /^Fold #3 grep "thinking"/)
  assert.equal(JSON.stringify(frozen), before, 'no read mutates the state')
})

// ---------------------------------------------------------------------------
// Helpers

/**
 * The host's deriveEventMessage for a journal's events (docs/02 §2).
 *
 * @param {readonly SessionEvent[]} events
 * @returns {import('../host/tools/recall.js').RecallSession}
 */
function journalSession(events) {
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  return {
    eventAt: (seq) => bySeq.get(seq),
    deriveEventMessage(event) {
      switch (event.type) {
        case 'user/message':
        case 'system/message':
          return event.data
        case 'assistant/message':
        case 'tool/result':
          return event.data.message
        default:
          return null
      }
    },
  }
}

/** @template T @param {T} value @returns {T} */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(/** @type {any} */ (value)[key])
  }
  return value
}

test('the live M4 session: two folds, an index, a grep and an exact range', () => {
  const events = journalEvents(readJournalText(join(M2_LOGS, 'm4-recall.jsonl')))
  const state = events.reduce(apply, initialState())
  const session = journalSession(events)
  assert.deepEqual(state.order, ['T1', 'T2'])
  assert.equal(state.folds.length, 2)

  const list = listFolds(state, session)
  assert.match(
    list,
    /^Folds \(2\):\n#1 T1 · billing review · 4 msgs · ~[\d.]+k tokens\n#2 T2 · ops review · 4 msgs · ~[\d.]+k tokens$/,
  )

  const index = foldIndex(state, session, 1)
  const lines = index.split('\n')
  assert.equal(lines[0], 'Fold #1 · T1 · billing review · 4 messages')
  assert.equal(lines.length, 5, 'four messages plus the header')

  const hits = foldGrep(state, session, 1, 'invoice')
  assert.match(hits, /^Fold #1 grep "invoice" \(\d+ hits?\):\nL\d: /)

  const range = foldRange(state, session, 1, 1, 4)
  assert.match(range, /^Fold #1 lines 1-4:\nL1 \{/)
  assert.ok(range.includes('INV-2026-4417'), 'the exact original message keeps the value')
})
