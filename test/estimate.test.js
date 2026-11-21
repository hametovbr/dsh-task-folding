// host/domain/estimate.js: the per-session token cache, the span fallback chain and the invalid-value
// guards. A fold boundary measures its span cold in a fresh process (docs/06 §4), so these tests
// drive the estimator directly with a counting token meter instead of through the runner.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CACHE_LIMIT, SpanEstimator } from '../host/domain/estimate.js'
import { at } from './fixtures/tools.js'

/**
 * A token meter that counts calls and answers with a fixed value (or a caller-supplied one).
 *
 * @param {number | (() => number)} [value]
 */
function countingMeter(value = 10) {
  /** @type {any} */
  const meter = {
    calls: 0,
    /** @param {any} _message */
    estimateMessage(_message) {
      meter.calls += 1
      return typeof value === 'function' ? value() : value
    },
  }
  return meter
}

/**
 * The host session subset SpanEstimator reads (docs/02 §2), with one event per surface seq.
 *
 * @param {{ nodes?: number[], id?: string }} [options]
 */
function sessionOf(options = {}) {
  const nodes = options.nodes ?? [0, 1, 2, 3, 4, 5]
  /** @type {Map<number, any>} */
  const events = new Map()
  for (const seq of nodes) {
    events.set(seq, {
      type: 'user/message',
      seq,
      data: { message: { role: 'user', content: [{ type: 'text', text: `m${seq}` }] } },
    })
  }
  return {
    id: options.id ?? 'session-1',
    surface: { nodes },
    /** @param {number} seq */
    eventAt: (seq) => events.get(seq),
    /** @param {any} event */
    deriveEventMessage: (event) => event.data.message,
  }
}

/** A task whose span can be located on the surface. @param {{ beginCut?: number | null, spanStart?: number | null }} cuts */
function taskOf(cuts = {}) {
  return {
    beginCut: cuts.beginCut === undefined ? 1 : cuts.beginCut,
    spanStart: cuts.spanStart === undefined ? 2 : cuts.spanStart,
  }
}

// ---------------------------------------------------------------------------
// span(): the fallback chain

test('span starts at spanStart and runs to the surface tail', () => {
  const meter = countingMeter(10)
  const estimator = new SpanEstimator(meter)
  const session = sessionOf()
  // spanStart is surface position 2; positions 2..5 are measured.
  assert.equal(estimator.span(session, taskOf({ beginCut: 1, spanStart: 2 })), 40)
  assert.equal(meter.calls, 4)
})

test('a missing spanStart falls back to beginCut + 1', () => {
  const meter = countingMeter(10)
  const session = sessionOf()
  // beginCut is surface position 1, so the span starts at position 2 and covers 4 nodes.
  assert.equal(new SpanEstimator(meter).span(session, taskOf({ beginCut: 1, spanStart: null })), 40)
  assert.equal(meter.calls, 4, 'only the four nodes after the begin cut are measured')
})

test('a negative spanStart falls back to beginCut + 1', () => {
  const meter = countingMeter(10)
  const session = sessionOf()
  // -1 is the ABSORBED sentinel (host/domain/cuts.js); it is never a surface position.
  assert.equal(new SpanEstimator(meter).span(session, taskOf({ beginCut: 1, spanStart: -1 })), 40)
  assert.equal(meter.calls, 4)
})

test('a spanStart that is not on the surface falls back to beginCut + 1', () => {
  const meter = countingMeter(10)
  const session = sessionOf()
  assert.equal(new SpanEstimator(meter).span(session, taskOf({ beginCut: 1, spanStart: 999 })), 40)
  assert.equal(meter.calls, 4)
})

test('a task with neither a spanStart nor a usable beginCut returns -1', () => {
  const cases = [
    taskOf({ beginCut: null, spanStart: null }),
    taskOf({ beginCut: -1, spanStart: null }),
    taskOf({ beginCut: 999, spanStart: null }),
  ]
  for (const task of cases) {
    const meter = countingMeter(10)
    assert.equal(new SpanEstimator(meter).span(sessionOf(), task), -1)
    assert.equal(meter.calls, 0, 'an unlocatable span measures nothing')
  }
})

test('a beginCut at the tail leaves an empty span and returns 0', () => {
  const meter = countingMeter(10)
  const session = sessionOf()
  assert.equal(new SpanEstimator(meter).span(session, taskOf({ beginCut: 5, spanStart: null })), 0)
  assert.equal(meter.calls, 0, 'nothing follows the begin cut')
})

test('a beginCut that moved off the surface leaves the span unlocatable', () => {
  // Cut translation can leave a task whose begin cut is no longer a surface node; the estimator
  // answers -1 so the runner can treat the span as unknown instead of measuring the wrong nodes.
  const session = sessionOf({ nodes: [7, 8] })
  assert.equal(
    new SpanEstimator(countingMeter(10)).span(session, taskOf({ beginCut: 9, spanStart: null })),
    -1,
  )
})

// ---------------------------------------------------------------------------
// The per-session cache

test('the seq cache is per session: the same seq in two sessions measures twice', () => {
  const meter = countingMeter(10)
  const estimator = new SpanEstimator(meter)
  const first = sessionOf({ id: 'session-1' })
  const second = sessionOf({ id: 'session-2' })
  assert.equal(estimator.node(first, 3), 10)
  assert.equal(meter.calls, 1)
  assert.equal(estimator.node(first, 3), 10, 'a repeated read in the same session is cached')
  assert.equal(meter.calls, 1)
  assert.equal(estimator.node(second, 3), 10, 'a seq is unique within a session, not across them')
  assert.equal(meter.calls, 2)
  assert.equal(estimator.node(second, 3), 10)
  assert.equal(meter.calls, 2)
})

test('a missing event measures as zero and is cached as zero', () => {
  const meter = countingMeter(10)
  const estimator = new SpanEstimator(meter)
  const session = sessionOf()
  assert.equal(estimator.node(session, 999), 0)
  assert.equal(estimator.node(session, 999), 0)
  assert.equal(meter.calls, 0, 'the meter never sees a seq without an event')
})

test('a meter that answers nonsense measures as zero', () => {
  const values = [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]
  for (const value of values) {
    assert.equal(new SpanEstimator(countingMeter(value)).node(sessionOf(), 1), 0)
  }
  assert.equal(new SpanEstimator(countingMeter(0)).text('anything'), 0)
})

test('the cache evicts the oldest entry at the limit', () => {
  const meter = countingMeter(10)
  const estimator = new SpanEstimator(meter, 2)
  const session = sessionOf()
  assert.equal(estimator.node(session, 0), 10)
  assert.equal(estimator.node(session, 1), 10)
  assert.equal(estimator.node(session, 2), 10)
  assert.equal(meter.calls, 3)
  assert.equal(estimator.node(session, 0), 10, 'seq 0 was evicted, so it is measured again')
  assert.equal(meter.calls, 4)
  assert.equal(estimator.node(session, 2), 10, 'seq 2 is still cached')
  assert.equal(meter.calls, 4)
})

test('a zero limit still returns a measurement', () => {
  // Degenerate configuration: nothing is cached, but the estimate is still correct.
  const meter = countingMeter(10)
  const estimator = new SpanEstimator(meter, 0)
  assert.equal(estimator.node(sessionOf(), 1), 10)
  assert.equal(meter.calls, 1)
})

test('the default cache limit is the exported bound', () => {
  assert.equal(new SpanEstimator(countingMeter()).limit, CACHE_LIMIT)
  assert.ok(CACHE_LIMIT > 0)
})

// ---------------------------------------------------------------------------
// regionTokens(): slices of the current surface

test('regionTokens sums an inclusive slice and reuses cached seqs', () => {
  const meter = countingMeter(10)
  const estimator = new SpanEstimator(meter)
  const session = sessionOf()
  assert.equal(estimator.regionTokens(session, session.surface.nodes, 1, 3), 30)
  assert.equal(meter.calls, 3)
  assert.equal(estimator.regionTokens(session, session.surface.nodes, 2, 4), 30)
  assert.equal(meter.calls, 4, 'only position 4 was new')
})

test('regionTokens reuses a cache the node() path created', () => {
  const meter = countingMeter(10)
  const estimator = new SpanEstimator(meter)
  const session = sessionOf()
  assert.equal(estimator.node(session, 2), 10)
  assert.equal(estimator.regionTokens(session, session.surface.nodes, 2, 3), 20)
  assert.equal(meter.calls, 2, 'seq 2 came from the cache')
})

test('an empty or out-of-range region measures as zero', () => {
  const meter = countingMeter(10)
  const estimator = new SpanEstimator(meter)
  const session = sessionOf()
  assert.equal(estimator.regionTokens(session, session.surface.nodes, 3, 2), 0)
  assert.equal(meter.calls, 0)
  // The caller may hand a range wider than the node list; missing positions are skipped, not read.
  assert.equal(estimator.regionTokens(session, [0, 1], 0, 5), 20)
  assert.equal(meter.calls, 2)
})

// ---------------------------------------------------------------------------
// text(): the summarizer's validation estimate

test('text measures one user text message through the host meter', () => {
  /** @type {any[]} */
  const seen = []
  const meter = {
    /** @param {any} message */
    estimateMessage(message) {
      seen.push(message)
      return 42
    },
  }
  const estimator = new SpanEstimator(meter)
  assert.equal(estimator.text('## Done\nshort'), 42)
  assert.deepEqual(at(seen, 0), {
    role: 'user',
    content: [{ type: 'text', text: '## Done\nshort' }],
  })
})

test('text falls back to zero when the meter cannot answer', () => {
  for (const value of [Number.NaN, -1, 0, Number.POSITIVE_INFINITY]) {
    assert.equal(new SpanEstimator(countingMeter(value)).text('text'), 0)
  }
})
