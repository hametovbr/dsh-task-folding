// The node form on all three commit sites (ADR 0009): a self fold, a delegate fold and the
// implicit turn fold must each commit exactly one heading (task folds only), one trailer and the
// pinned sections — never a second copied trailer.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SpanEstimator } from '../host/domain/estimate.js'
import { FOLD_REFERENCE_HEADING, FOLD_VERBATIM_HEADING } from '../host/domain/texts.js'
import { createFoldRunner } from '../host/runtime/scheduler.js'
import { foldIndex } from '../host/tools/recall.js'
import { Sim } from './fixtures/sim.js'
import { at, fakeMeter, harnessOf, sessionOf } from './fixtures/tools.js'

/** A summary long enough to be usable by the task tools. */
const SUMMARY = `## Done\n${'Summarized the work with its changed paths and the reason for each choice. '.repeat(4)}`

/** The trailer count of a node text. */
function trailers(/** @type {string} */ text) {
  return text.split('— fold of').length - 1
}

/**
 * A runner whose region sizes come from the test's estimator, so the pinned sections see a
 * predictable adaptive budget while the tool harness keeps its own meter for the verdicts.
 *
 * @param {Sim} sim
 * @param {{ delegate?: any }} [options]
 */
function runnerOf(sim, options = {}) {
  /** @type {any[]} */
  const calls = []
  const engine = {
    calls,
    /** @param {any} request */
    async fold(request) {
      calls.push(request)
      sim.compact(request.region.startSeq, request.region.endSeq)
      return { start: request.region.startSeq, end: request.region.endSeq }
    },
    balancedBefore: () => true,
    balancedAfter: () => true,
    /** @param {any} _request */
    async reject(_request) {
      throw new Error('no failed generation is recorded in the form tests')
    },
    /** @param {unknown} _error @returns {'busy' | 'summary' | 'other'} */
    classify: (_error) => 'other',
  }
  /** @type {any} */
  const estimator = {
    regionTokens: () => 10_000,
    text: (/** @type {string} */ text) => Math.ceil(text.length / 4),
  }
  /** @type {string[]} */
  const logs = []
  const runner = createFoldRunner({
    stateOf: async () => sim.state,
    engine: async () => engine,
    estimator,
    logger: { warn: (/** @type {string} */ message) => logs.push(message) },
    now: () => 0,
    delegate: options.delegate,
  })
  return { runner, engine, estimator, logs }
}

/** @param {Sim} sim */
function agentOf(sim) {
  return { session: sessionOf(sim), options: { provider: 'test-provider', model: 'test-model' } }
}

/** A summarizer seam whose generation the test settles explicitly. */
function delegateSeam() {
  /** @type {{ agent: any, target: any, region: any, signal: AbortSignal | undefined }[]} */
  const starts = []
  /** @type {{ resolve: (result: any) => void, reject: (error: unknown) => void }[]} */
  const settle = []
  const delegate = {
    supports: () => true,
    /**
     * @param {any} agent
     * @param {any} target
     * @param {any} region
     * @param {AbortSignal | undefined} signal
     */
    start(agent, target, region, signal) {
      starts.push({ agent, target, region, signal })
      return new Promise((resolve, reject) => settle.push({ resolve, reject }))
    },
  }
  return {
    delegate,
    starts,
    /** @param {number} index @param {any} result */
    resolve(index, result) {
      at(settle, index).resolve(result)
    },
  }
}

/** Let the runner's deferred microtasks run; no timer is involved. */
async function flushMicrotasks() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

// ---------------------------------------------------------------------------
// Self fold (host/runtime/scheduler.js)

test('the self path pins the region human and references the plugin, quoting nothing else', async () => {
  const sim = new Sim()
  const h = harnessOf(sim, { meter: fakeMeter() })
  // The opening request is outside the region: a fold pins what it shadows, not the whole log.
  sim.user('Fix the redirect loop before adding the banner.')
  await h.batch([{ name: 'task_begin', args: { title: 'Fix login redirect loop' } }])
  sim.work(2)
  sim.user('The advisor says: check the cookie path.', { kind: 'advisor:concern' })
  sim.user('Re-injected agent rules.', { kind: 'agent-instructions' })
  sim.user('The human also asked to keep the banner.', { kind: 'user' })
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])
  sim.say()
  assert.equal(sim.state.tasks.T1?.status, 'queued', 'the task is due for a self fold')

  const { runner, engine } = runnerOf(sim)
  const report = await runner.pass(agentOf(sim), undefined, true)
  assert.equal(report.folded, 1)
  const text = at(at(engine.calls, 0).blocks, 0).text

  assert.match(text, /^# T1 · Fix login redirect loop\n/)
  assert.ok(text.includes('Summarized the work'), 'the model summary is the node body')
  assert.ok(text.includes(`${FOLD_VERBATIM_HEADING}\n> The human also asked to keep the banner.`))
  assert.equal(text.includes('before adding the banner'), false, 'text outside the region is not pinned')
  assert.ok(text.includes(FOLD_REFERENCE_HEADING))
  assert.match(
    text,
    /> \[advisor:concern · seq \d+\] folded into this node; the text is in fold_recall\(\{ task: "T1" \}\)/,
  )
  assert.equal(text.includes('The advisor says'), false, 'a plugin sentence is referenced, not quoted')
  assert.equal(text.includes('Re-injected agent rules.'), false, 'a re-injected kind is dropped')
  assert.equal(text.includes('<compacted-summary>'), false)
  assert.equal(trailers(text), 1)
})

test('a self summary that copied the node heading and trailer commits one of each', async () => {
  const sim = new Sim()
  const h = harnessOf(sim, { meter: fakeMeter() })
  await h.batch([{ name: 'task_begin', args: { title: 'Copied artifacts' } }])
  sim.work(2)
  const copied = [
    '# T1 · copied heading',
    '## Done',
    'The body the model wrote.',
    '',
    '<compacted-summary>',
    'an older fold',
    '</compacted-summary>',
    '',
    '— fold of T1 · 3 messages · ~1 tokens · outcome: done · originals: fold_recall({ task: "T1" })',
  ].join('\n')
  await h.batch([{ name: 'task_end', args: { summary: copied } }])
  sim.say()
  assert.equal(sim.state.tasks.T1?.status, 'queued')

  const { runner, engine } = runnerOf(sim)
  await runner.pass(agentOf(sim), undefined, true)
  const text = at(at(engine.calls, 0).blocks, 0).text
  assert.equal(text.match(/^# T1 · /gm)?.length, 1, 'one heading')
  assert.equal(trailers(text), 1, 'one trailer')
  assert.ok(text.includes('The body the model wrote.'))
  assert.equal(text.includes('<compacted-summary>'), false)
})

// ---------------------------------------------------------------------------
// Delegate fold (host/runtime/generation.js, commit at the next boundary)

test('the delegate path commits the same node form as the self path', async () => {
  const sim = new Sim()
  const h = harnessOf(sim, { meter: fakeMeter() })
  await h.batch([{ name: 'task_begin', args: { title: 'Delegated review' } }])
  sim.work(2)
  sim.user('The advisor says: narrow the read set.', { kind: 'advisor:concern' })
  sim.user('The human wants the ledger total.', { kind: 'user' })
  await h.batch([{ name: 'task_end', args: { summary: 'Too short.' } }])
  assert.equal(sim.state.tasks.T1?.status, 'delegate', 'a short summary delegates')

  const seam = delegateSeam()
  const { runner, engine } = runnerOf(sim, { delegate: seam.delegate })
  const agent = agentOf(sim)
  await runner.pass(agent, undefined, true)
  assert.equal(seam.starts.length, 1, 'one background generation started')
  assert.equal(engine.calls.length, 0, 'the pass that starts it commits nothing')

  seam.resolve(0, { blocks: [{ type: 'text', text: '## Done\nReviewed the ledger and the files.' }] })
  await flushMicrotasks()
  const report = await runner.pass(agent, undefined, true)
  assert.equal(report.folded, 1)
  const text = at(at(engine.calls, 0).blocks, 0).text

  assert.match(text, /^# T1 · Delegated review\n/)
  assert.ok(text.includes('## Done\nReviewed the ledger and the files.'), 'the generated summary is the body')
  assert.ok(text.includes(`${FOLD_VERBATIM_HEADING}\n> The human wants the ledger total.`))
  assert.match(
    text,
    /> \[advisor:concern · seq \d+\] folded into this node; the text is in fold_recall\(\{ task: "T1" \}\)/,
  )
  assert.equal(text.includes('The advisor says'), false)
  assert.equal(text.includes('<compacted-summary>'), false)
  assert.equal(trailers(text), 1)
})

// ---------------------------------------------------------------------------
// Implicit turn fold (host/runtime/generation.js)

test('the implicit turn path has no task heading and points at its fold number', async () => {
  const sim = new Sim()
  sim.push({ type: 'turn/start', data: { turn: 1 } })
  sim.user('The request that starts the turn.')
  sim.work(3)
  sim.user('An advisor note during the turn.', { kind: 'advisor:concern' })

  const seam = delegateSeam()
  const { runner, engine } = runnerOf(sim, { delegate: seam.delegate })
  const agent = agentOf(sim)
  await runner.turnStopping({ agent, turn: 1, signal: undefined })
  assert.equal(seam.starts.length, 1, 'one background turn summary started')

  seam.resolve(0, { blocks: [{ type: 'text', text: '## Done\nDid the work of the turn.' }] })
  await flushMicrotasks()
  await runner.preStep({ agent, turn: 2, step: 1, signal: undefined }, async () => ({}))
  assert.equal(engine.calls.length, 1, 'the next boundary committed the turn fold')

  const text = at(at(engine.calls, 0).blocks, 0).text
  assert.doesNotMatch(text, /^# T/, 'an implicit node has no task heading')
  assert.ok(text.includes('## Done\nDid the work of the turn.'))
  assert.ok(text.includes(`${FOLD_VERBATIM_HEADING}\n> The request that starts the turn.`))
  assert.match(
    text,
    /> \[advisor:concern · seq \d+\] folded into this node; the text is in fold_recall\(\{ fold: 1 \}\)/,
  )
  assert.equal(text.includes('An advisor note'), false)
  assert.equal(text.includes('<compacted-summary>'), false)
  assert.equal(trailers(text), 1)
  assert.match(text, /— fold of \d+ messages · ~10\.0k tokens · originals: fold_recall\(\{ fold: 1 \}\)/)
})

test('the implicit trailer numbers the commit as fold_recall does', async () => {
  const sim = new Sim()
  const h = harnessOf(sim, { meter: fakeMeter() })
  await h.batch([{ name: 'task_begin', args: { title: 'first fold' } }])
  sim.work(2)
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])
  sim.say()

  const seam = delegateSeam()
  const { runner, engine } = runnerOf(sim, { delegate: seam.delegate })
  const agent = agentOf(sim)
  await runner.pass(agent, undefined, true)
  assert.equal(sim.state.folds.length, 1, 'the task fold is fold #1')

  // A new turn, with no open task: its span becomes fold #2.
  sim.push({ type: 'turn/start', data: { turn: 2 } })
  sim.user('The request of the second turn.')
  sim.work(3)
  await runner.turnStopping({ agent, turn: 2, signal: undefined })
  assert.equal(seam.starts.length, 1)
  seam.resolve(0, { blocks: [{ type: 'text', text: '## Done\nThe second turn.' }] })
  await flushMicrotasks()
  await runner.preStep({ agent, turn: 3, step: 1, signal: undefined }, async () => ({}))
  assert.equal(engine.calls.length, 2)
  const text = at(at(engine.calls, 1).blocks, 0).text
  assert.match(text, /originals: fold_recall\(\{ fold: 2 \}\)/)
  assert.equal(sim.state.folds.length, 2, 'the trailer names the row the reader will find')
  assert.equal(
    foldIndex(sim.state, sessionOf(sim), 2).split('\n')[0],
    'Fold #2 · auto compaction · 7 messages',
  )
})

// ---------------------------------------------------------------------------
// The economy rule still sees the finished node (the adaptive budget is inside it)

test('a node that would not be smaller than its span never reaches the engine', async () => {
  const sim = new Sim()
  const h = harnessOf(sim, { meter: fakeMeter() })
  await h.batch([{ name: 'task_begin', args: { title: 'tiny span' } }])
  sim.work(2)
  await h.batch([{ name: 'task_end', args: { summary: SUMMARY } }])
  sim.say()

  /** @type {any[]} */
  const calls = []
  /** @type {any} */
  const engine = {
    calls,
    async fold(/** @type {any} */ request) {
      calls.push(request)
      sim.compact(request.region.startSeq, request.region.endSeq)
    },
    balancedBefore: () => true,
    balancedAfter: () => true,
    async reject() {},
    /** @returns {'busy' | 'summary' | 'other'} */
    classify: () => 'other',
  }
  /** @type {string[]} */
  const logs = []
  const runner = createFoldRunner({
    stateOf: async () => sim.state,
    engine: async () => engine,
    // The span is cheap and the node is expensive: the pre-check must skip before the host is asked.
    estimator: /** @type {any} */ ({ regionTokens: () => 100, text: () => 10_000 }),
    logger: { warn: (/** @type {string} */ message) => logs.push(message) },
    now: () => 0,
  })
  const report = await runner.pass(agentOf(sim), undefined, true)
  assert.deepEqual(report.skipped, ['T1'])
  assert.equal(calls.length, 0)
  assert.match(at(logs, 0), /would not be smaller/)
  assert.ok(new SpanEstimator(fakeMeter()).text('tiny') > 0, 'the real estimator is untouched')
})
