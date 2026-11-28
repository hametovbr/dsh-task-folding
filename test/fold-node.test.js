// The fold node (docs/03 §7.3, ADR 0009): the sanitizer in both directions, the pin decision order
// and its caps, and the node form of a task fold and an implicit turn fold.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import fc from 'fast-check'

import {
  MAX_PIN_CHARS,
  MAX_SECTION_CHARS,
  MIN_PIN_TOKENS,
  REINJECTED_KINDS,
  finalizeFoldBlocks,
  foldBlocksText,
  nodeTokensOf,
  sanitizeFoldText,
} from '../host/domain/fold-node.js'
import { FOLD_ELIDED_SUMMARY, FOLD_REFERENCE_HEADING, FOLD_VERBATIM_HEADING } from '../host/domain/texts.js'
import { loadLog, logNames } from './fixtures/journals.js'

/** @typedef {import('../host/domain/fold-node.js').FoldNodeContext} FoldNodeContext */
/** @typedef {import('../host/domain/fold-node.js').FoldNodeInput} FoldNodeInput */
/** @typedef {import('../host/domain/fold-node.js').InboundNode} InboundNode */

/** Predictable tokens: a quarter of a character each, so pin sizes are readable in a test. */
const ESTIMATOR = { text: (/** @type {string} */ text) => Math.ceil(text.length / 4) }

/**
 * The node context for model blocks: defaults, plus the node's own size unless the test pins it.
 *
 * @param {readonly any[]} blocks
 * @param {Partial<FoldNodeContext>} [overrides]
 * @returns {FoldNodeContext}
 */
function contextOf(blocks, overrides = {}) {
  /** @type {FoldNodeInput} */
  const input = {
    inbound: overrides.inbound ?? [],
    spanTokens: overrides.spanTokens ?? 10_000,
    estimator: overrides.estimator ?? ESTIMATOR,
    task:
      overrides.task === undefined
        ? { id: 'T1', title: 'Fix login redirect loop', outcome: 'done' }
        : overrides.task,
    fold: overrides.fold ?? null,
    messages: overrides.messages ?? 12,
  }
  return {
    ...input,
    nodeTokens: overrides.nodeTokens ?? nodeTokensOf(blocks, input),
  }
}

/** @param {string} text */
const one = (text) => [{ type: 'text', text }]

/**
 * The committed node text for model blocks.
 *
 * @param {readonly any[]} blocks
 * @param {Partial<FoldNodeContext>} [overrides]
 */
function nodeText(blocks, overrides = {}) {
  const committed = finalizeFoldBlocks(blocks, contextOf(blocks, overrides))
  const block = committed[0]
  return block === undefined ? '' : block.text
}

/**
 * The committed node text for a model summary.
 *
 * @param {string} summary
 * @param {Partial<FoldNodeContext>} [overrides]
 */
function nodeOf(summary, overrides = {}) {
  return nodeText(one(summary), overrides)
}

/** @param {readonly InboundNode[]} inbound @param {Partial<FoldNodeContext>} [overrides] */
function nodeWith(inbound, overrides = {}) {
  return nodeOf('## Done\nDid the work.', { inbound, ...overrides })
}

/** The number of plugin trailers a node carries. */
function trailers(/** @type {string} */ text) {
  return text.split('— fold of').length - 1
}

/** The text of a corpus `user/message` event. */
function userText(/** @type {any} */ event) {
  const content = event.data && Array.isArray(event.data.content) ? event.data.content : []
  return content
    .filter((/** @type {any} */ block) => block && typeof block.text === 'string')
    .map((/** @type {any} */ block) => block.text)
    .join('\n')
}

// ---------------------------------------------------------------------------
// sanitizeFoldText

test('summary mode strips a copied heading and trailer, pin mode only the trailer', () => {
  const copied = [
    '# T1 · copied heading',
    '## Done',
    'kept body',
    '',
    '— fold of T1 · 3 messages · ~1 tokens · outcome: done · originals: fold_recall({ task: "T1" })',
  ].join('\n')
  assert.equal(sanitizeFoldText(copied, 'summary'), '## Done\nkept body')
  assert.equal(
    sanitizeFoldText(copied, 'pin'),
    '# T1 · copied heading\n## Done\nkept body',
    'a user text may legitimately start with a heading: pin mode keeps it',
  )
})

test('a nested compacted-summary is elided in both modes, never silently truncated', () => {
  const text = 'before\n<compacted-summary>\nan older fold\n</compacted-summary>\nafter'
  for (const mode of /** @type {const} */ (['summary', 'pin'])) {
    const sanitized = sanitizeFoldText(text, mode)
    assert.ok(sanitized.includes('before'), `${mode}: the text before the block stays`)
    assert.ok(sanitized.includes('after'), `${mode}: the text after the block stays`)
    assert.ok(sanitized.includes(FOLD_ELIDED_SUMMARY), `${mode}: the block became a marker`)
    assert.equal(sanitized.includes('<compacted-summary>'), false, `${mode}: no nested opening tag`)
    assert.equal(sanitizeFoldText(sanitized, mode), sanitized, `${mode}: idempotent`)
  }
})

test('an unclosed compacted-summary tag is left alone', () => {
  const text = 'before\n<compacted-summary>\nnever closed'
  assert.equal(sanitizeFoldText(text, 'summary'), text)
})

test('sanitizeFoldText is idempotent for arbitrary artifact mixes', () => {
  const artifact = fc.oneof(
    fc.string(),
    fc.constant('— fold of T1 · 2 messages · ~1 tokens'),
    fc.constant('# T2 · copied'),
    fc.constant('<compacted-summary>old</compacted-summary>'),
    fc.constant(''),
  )
  fc.assert(
    fc.property(fc.array(artifact, { maxLength: 20 }), (parts) => {
      const text = parts.join('\n')
      for (const mode of /** @type {const} */ (['summary', 'pin'])) {
        const once = sanitizeFoldText(text, mode)
        assert.equal(sanitizeFoldText(once, mode), once, `${mode}: ${JSON.stringify(text)}`)
      }
    }),
    { numRuns: 200 },
  )
})

test('the replay corpus: sanitizing real summaries changes only copied plugin artifacts', () => {
  let summaries = 0
  for (const name of logNames()) {
    const events = loadLog(name)
    for (const event of events) {
      if (event.type === 'user/message') {
        const text = userText(event)
        const kind = event.data && event.data.source ? event.data.source.kind : undefined
        if (text === '' || kind === 'user') continue
        // Pin mode must never rewrite a host-kind text that carries no plugin artifact.
        const pin = sanitizeFoldText(text, 'pin')
        if (!/— fold of T\d+ · /.test(text) && !text.includes('<compacted-summary>'))
          assert.equal(pin, text.trim(), `${name} seq ${event.seq}: host text rewritten in pin mode`)
        continue
      }
      if (event.type !== 'compaction/summary') continue
      const blocks = event.data && Array.isArray(event.data.summary) ? event.data.summary : []
      for (const block of blocks) {
        if (!block || typeof block.text !== 'string') continue
        summaries += 1
        const sanitized = sanitizeFoldText(block.text, 'summary')
        assert.equal(sanitizeFoldText(sanitized, 'summary'), sanitized, `${name}: idempotent`)
        assert.equal(sanitized.includes('<compacted-summary>'), false, `${name}: no nested checkpoint`)
        if (!/— fold of T\d+ · /.test(block.text) && !/^# T\d+ · /m.test(block.text))
          assert.equal(sanitized, block.text.trim(), `${name}: a plain summary is untouched`)
        else assert.doesNotMatch(sanitized, /— fold of T\d+ · /, `${name}: a copied trailer is gone`)
      }
    }
  }
  assert.ok(summaries >= 8, `the corpus carries folds to check, got ${summaries}`)
})

// ---------------------------------------------------------------------------
// Pin rules

test('the principal is quoted verbatim; the section has the exact heading', () => {
  const node = nodeWith([{ seq: 7, kind: 'user', text: 'Fix the redirect loop before adding the banner.' }])
  assert.ok(node.includes(`${FOLD_VERBATIM_HEADING}\n> Fix the redirect loop before adding the banner.`))
  assert.equal(node.includes(FOLD_REFERENCE_HEADING), false, 'nothing to reference')
})

test('a multi-line principal text is one blockquote line per source line', () => {
  const node = nodeWith([{ seq: 8, kind: 'user', text: 'first line\n\nsecond line' }])
  assert.ok(node.includes(`${FOLD_VERBATIM_HEADING}\n> first line\n>\n> second line`))
})

test('plugin and unknown kinds are referenced, never quoted', () => {
  const node = nodeWith([
    { seq: 469, kind: 'advisor:concern', text: 'You missed the retry semantics.' },
    { seq: 470, kind: 'some-future-plugin', text: 'A sentence of its own.' },
  ])
  assert.ok(node.includes(FOLD_VERBATIM_HEADING) === false, 'no human text, so no verbatim section')
  assert.ok(node.includes(FOLD_REFERENCE_HEADING))
  assert.ok(
    node.includes(
      `> [advisor:concern · seq 469] folded into this node; the text is in fold_recall({ task: "T1" })`,
    ),
  )
  assert.ok(
    node.includes(
      `> [some-future-plugin · seq 470] folded into this node; the text is in fold_recall({ task: "T1" })`,
    ),
  )
  assert.equal(node.includes('You missed the retry semantics.'), false, 'a plugin quote is a feedback loop')
  assert.equal(node.includes('A sentence of its own.'), false)
})

test('re-injected kinds produce no line at all', () => {
  for (const kind of REINJECTED_KINDS) {
    const node = nodeWith([{ seq: 3, kind, text: 'live context that is re-injected every turn' }])
    assert.equal(node.includes('live context'), false, `${kind}: no quote`)
    assert.equal(node.includes(FOLD_VERBATIM_HEADING), false, `${kind}: no verbatim section`)
    assert.equal(node.includes(FOLD_REFERENCE_HEADING), false, `${kind}: no reference section`)
    assert.equal(node.includes(kind), false, `${kind}: not even named`)
  }
})

test('an empty inbound text carries nothing and produces no section', () => {
  const node = nodeWith([{ seq: 4, kind: 'user', text: '   \n ' }])
  assert.equal(node.includes(FOLD_VERBATIM_HEADING), false)
  assert.equal(node.includes(FOLD_REFERENCE_HEADING), false)
})

// ---------------------------------------------------------------------------
// Caps and the adaptive budget

test('a node over 2,000 characters is referenced by length, not quoted', () => {
  const text = 'x'.repeat(MAX_PIN_CHARS + 1)
  const node = nodeWith([{ seq: 9, kind: 'user', text }])
  assert.equal(node.includes('x'.repeat(20)), false, 'the long text is not quoted')
  assert.ok(
    node.includes(`> [user · seq 9] ${MAX_PIN_CHARS + 1} characters not pinned; the text is in`),
    'the marker names the kind and the length',
  )
  assert.equal(node.includes(FOLD_VERBATIM_HEADING), false)
  assert.ok(node.includes(FOLD_REFERENCE_HEADING))
})

test('the adaptive budget replaces pins with markers when it falls below the floor', () => {
  // floor(200 / 2) - 90 = 10 tokens: below MIN_PIN_TOKENS, so nothing can be quoted honestly.
  const node = nodeWith([{ seq: 5, kind: 'user', text: 'a'.repeat(80) }], {
    spanTokens: 200,
    nodeTokens: 90,
  })
  assert.equal(node.includes(FOLD_VERBATIM_HEADING), false)
  assert.ok(node.includes(`> [user · seq 5] 80 characters not pinned; the text is in`))
})

test('the adaptive budget keeps quoting while it lasts, then names the rest', () => {
  // floor(2000 / 2) - 900 = 100 tokens of pin budget; each 300-character quote costs ~76.
  const node = nodeWith(
    [
      { seq: 1, kind: 'user', text: 'a'.repeat(300) },
      { seq: 2, kind: 'user', text: 'b'.repeat(300) },
    ],
    { spanTokens: 2000, nodeTokens: 900 },
  )
  assert.ok(node.includes(`> ${'a'.repeat(300)}`), 'the first quote fits')
  assert.equal(node.includes('b'.repeat(10)), false, 'the second is not quoted')
  assert.ok(node.includes(`> [user · seq 2] 300 characters not pinned; the text is in`))
})

test('the section cap keeps a section within 4,000 characters and counts the rest', () => {
  const inbound = [0, 1, 2].map((i) => ({
    seq: i + 1,
    kind: 'user',
    text: 'q'.repeat(MAX_PIN_CHARS - 10),
  }))
  const node = nodeWith(/** @type {InboundNode[]} */ (inbound), { spanTokens: 1_000_000, nodeTokens: 0 })
  const section = node.slice(node.indexOf(FOLD_VERBATIM_HEADING)).split('\n\n')[0] ?? ''
  assert.ok(section.length <= MAX_SECTION_CHARS, `section is ${section.length} characters`)
  assert.match(section, /\[…\d+ folded messages not pinned; the text is in fold_recall/)
})

test('the reference section cap applies to reference lines too', () => {
  const inbound = Array.from({ length: 80 }, (_, i) => ({
    seq: i + 1,
    kind: 'advisor:concern',
    text: 'a plugin sentence',
  }))
  const node = nodeWith(/** @type {InboundNode[]} */ (inbound))
  const section = node.slice(node.indexOf(FOLD_REFERENCE_HEADING)).split('\n\n')[0] ?? ''
  assert.ok(section.length <= MAX_SECTION_CHARS, `section is ${section.length} characters`)
  assert.match(section, /\[…\d+ folded messages not pinned; the text is in fold_recall/)
})

// ---------------------------------------------------------------------------
// Node form

test('a task node is a heading, the summary, the pinned sections and one trailer', () => {
  const node = nodeOf('## Done\nDid the work.', {
    inbound: [
      { seq: 1, kind: 'user', text: 'the human requirement' },
      { seq: 2, kind: 'advisor:concern', text: 'the advisor concern' },
    ],
    task: { id: 'T5', title: 'Review PR #98', outcome: 'failed' },
  })
  assert.match(node, /^# T5 · Review PR #98\n/)
  assert.ok(node.includes('## Done\nDid the work.'))
  assert.ok(node.indexOf(FOLD_VERBATIM_HEADING) < node.indexOf(FOLD_REFERENCE_HEADING), 'verbatim first')
  assert.ok(
    node.indexOf(FOLD_REFERENCE_HEADING) < node.indexOf('— fold of T5'),
    'sections before the trailer',
  )
  assert.equal(trailers(node), 1)
  assert.match(
    node,
    /— fold of T5 · 12 messages · ~10\.0k tokens · outcome: failed · originals: fold_recall\(\{ task: "T5" \}\)/,
  )
})

test('an implicit turn node has no task heading and points at the fold number', () => {
  const node = nodeOf('## Done\nThe turn summary.', { task: null, fold: 3, messages: 7, spanTokens: 999 })
  assert.doesNotMatch(node, /^# T/)
  assert.ok(node.includes('## Done\nThe turn summary.'))
  assert.equal(trailers(node), 1)
  assert.match(node, /— fold of 7 messages · ~999 tokens · originals: fold_recall\(\{ fold: 3 \}\)/)
})

test('an implicit node references a plugin node with the fold pointer', () => {
  const node = nodeWith([{ seq: 12, kind: 'advisor:concern', text: 'a concern' }], {
    task: null,
    fold: 2,
  })
  assert.ok(
    node.includes(
      '> [advisor:concern · seq 12] folded into this node; the text is in fold_recall({ fold: 2 })',
    ),
  )
})

test('a summary that copied the heading and the trailer yields exactly one of each', () => {
  const copied = [
    '# T1 · Fix login redirect loop',
    '## Done',
    'kept body',
    '',
    '— fold of T1 · 3 messages · ~1 tokens · outcome: done · originals: fold_recall({ task: "T1" })',
  ].join('\n')
  const node = nodeOf(copied)
  assert.equal(trailers(node), 1, 'one trailer')
  assert.equal(node.match(/^# T1 · /gm)?.length, 1, 'one heading')
  assert.ok(node.includes('kept body'))
})

test('a nested checkpoint inside the summary or a pinned text never reaches the node', () => {
  const node = nodeOf('## Done\n<compacted-summary>\nan older fold\n</compacted-summary>', {
    inbound: [{ seq: 4, kind: 'user', text: 'quote <compacted-summary>nested</compacted-summary> end' }],
  })
  assert.equal(node.includes('<compacted-summary>'), false)
  assert.equal(node.includes('</compacted-summary>'), false)
  assert.ok(node.includes(FOLD_ELIDED_SUMMARY))
})

test('foldBlocksText joins the model text blocks and ignores the others', () => {
  assert.equal(
    foldBlocksText([
      { type: 'text', text: 'first' },
      { type: 'tool-call', name: 'read' },
      null,
      { type: 'text', text: 'second' },
      { type: 'text' },
    ]),
    'first\nsecond',
  )
})

test('finalizeFoldBlocks returns exactly one text block', () => {
  const summary = one('## Done\nbody')
  const blocks = finalizeFoldBlocks(summary, contextOf(summary))
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0]?.type, 'text')
})

test('MIN_PIN_TOKENS is the documented plateau between quoting and marking', () => {
  // One token above the floor still quotes; one below marks. 160 chars of quote ~40 tokens.
  const text = 'a'.repeat(156)
  const quoted = nodeOf('## Done\nbody', {
    inbound: [{ seq: 1, kind: 'user', text }],
    spanTokens: 1000,
    nodeTokens: 460,
  })
  assert.ok(quoted.includes(`> ${text}`), '40 tokens of budget still quotes')
  const marked = nodeOf('## Done\nbody', {
    inbound: [{ seq: 1, kind: 'user', text }],
    spanTokens: 1000,
    nodeTokens: 462,
  })
  assert.equal(marked.includes(`> ${text}`), false)
  assert.equal(MIN_PIN_TOKENS, 40)
})
