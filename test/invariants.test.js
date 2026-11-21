// Milestone T2 (docs/09-testing-plan.md): the eight design invariants of docs/03-architecture.md
// (§2.4 cut translation, §4 reducer, §5 folding, §12) as properties over generated event
// streams, not hand-picked examples. Every property runs 200 cases from one fixed seed, so a
// failure is reproducible from the report alone (the seed and the raw program are printed).
//
// The kit in this file is a pared-down copy of test/fixtures/sim.js: the event envelope with
// increasing seqs, the surface bookkeeping (applySurface), the task-tool meta builders
// (beginMeta/endMeta, mirroring task_begin/task_end), batch/result emission with the host's
// repair shape, the compaction transaction (compaction/start, compaction/summary, replacing
// user/message, compaction/end), the pruner replacement and the fold-by-region path. It is
// copied instead of imported because the properties must observe and measure the surface at the
// exact moment each host event is emitted (fold regions, token estimates before/after), which
// the shared simulator does not expose. `at` follows test/fixtures/tools.js. Nothing in host/,
// client/, scripts/ or the shared fixtures is modified.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import fc from 'fast-check'

import { ABSORBED } from '../host/cuts.js'
import { SpanEstimator } from '../host/estimate.js'
import { dueTasks, resolveRegion } from '../host/planner.js'
import { apply, init, initialState, parseState, TERMINAL, WAITING } from '../host/projection.js'

/** @typedef {import('../host/types.js').SessionEvent} SessionEvent */
/** @typedef {import('../host/types.js').State} State */
/** @typedef {import('../host/types.js').Task} Task */
/** @typedef {import('../host/types.js').EndVerdict} EndVerdict */
/** @typedef {import('../host/planner.js').FoldRegion} FoldRegion */

/**
 * @typedef {{ kind: 'begin', title?: string }
 *   | { kind: 'end', id?: string, verdict?: EndVerdict }
 *   | { kind: 'other', name?: string, error?: boolean, chars?: number }} CallSpec
 */

/**
 * One committed fold, recorded at the moment the host transaction emitted it.
 *
 * @typedef {object} FoldRecord
 * @property {string} taskId
 * @property {number} start          first replaced seq (the task's spanStart)
 * @property {number} end            last replaced seq (the task's endCut)
 * @property {number} startIndex     its position in the pre-fold surface
 * @property {number} endIndex
 * @property {readonly number[]} nodesBefore the whole pre-fold surface (property 6 needs the region slice and its neighbours)
 * @property {boolean} nested        the task has a parent
 * @property {boolean} ancestorOpen  at least one ancestor was still open when the fold committed
 * @property {number} spanBefore     estimator.span of the task just before the fold
 * @property {number} spanAfter      estimator.span of the same task just after the fold
 * @property {number} regionTokens   estimate of the replaced region
 * @property {number} summaryTokens  estimate of the replacement node
 * @property {number} surfaceBefore  estimate of the whole surface before the fold
 * @property {number} surfaceAfter   estimate of the whole surface after the fold
 * @property {{ id: string, before: number, after: number }[]} ancestors open ancestors that stay measurable
 */

const SURFACE_TYPES = new Set(['system/message', 'user/message', 'assistant/message', 'tool/result'])

/**
 * A deterministic stand-in for ctx.tokenMeter.estimateMessage: four characters per token, at
 * least one token per message. Every property compares estimates of the same surface before and
 * after one change, so the estimator's arithmetic is what is under test here, not the host's
 * tokenizer.
 */
const meter = {
  /** @param {any} message */
  estimateMessage(message) {
    const content = message && Array.isArray(message.content) ? message.content : []
    let chars = 0
    for (const block of content) if (block && block.type === 'text') chars += String(block.text).length
    return Math.max(1, Math.ceil(chars / 4))
  },
}

/**
 * @template T
 * @param {readonly T[]} list
 * @param {number} index
 * @returns {T}
 */
function at(list, index) {
  const value = list[index]
  if (value === undefined) throw new Error(`no element ${index}`)
  return value
}

/**
 * Apply one event's surface op to a node list, exactly the way the host keeps its surface: an
 * append lands at the tail, a replace swaps the whole inclusive range for the new event's seq.
 * Copied from Sim.applySurface in test/fixtures/sim.js; returns what the replace removed so the
 * caller can describe the region a fold shadowed.
 *
 * @param {number[]} nodes
 * @param {SessionEvent} event
 * @returns {{ removed: number[], startIndex: number } | null}
 */
function applySurfaceOp(nodes, event) {
  const op = event.surfaceOp
  if (op === undefined || op === 'append') {
    nodes.push(event.seq)
    return null
  }
  const i = nodes.indexOf(op.startSeq)
  const j = nodes.indexOf(op.endSeq)
  if (i === -1 || j === -1 || i > j) {
    throw new Error(`invariants: surface cannot replace ${op.startSeq}..${op.endSeq} (event ${event.seq})`)
  }
  const removed = nodes.slice(i, j + 1)
  nodes.splice(i, j - i + 1, event.seq)
  return { removed, startIndex: i }
}

/** @param {SessionEvent} event @returns {boolean} */
function isReplaceEvent(event) {
  if (!SURFACE_TYPES.has(event.type)) return false
  const op = event.surfaceOp
  return typeof op === 'object' && op !== null && op.op === 'replace'
}

/** @param {SessionEvent} event @returns {import('../host/types.js').ReplaceOp} */
function replaceOpOf(event) {
  const op = event.surfaceOp
  if (typeof op !== 'object' || op === null) throw new Error('not a replace event')
  return op
}

/**
 * The host session subset SpanEstimator reads, at one moment of the surface.
 *
 * @param {Stream} stream
 * @param {readonly number[]} nodes
 */
function sessionOf(stream, nodes) {
  return {
    id: `generated-${stream.events.length}`,
    surface: { nodes },
    /** @param {number} seq */
    eventAt: (seq) => stream.bySeq.get(seq),
    /** @param {SessionEvent} event */
    deriveEventMessage: (event) => {
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

/** @param {number} chars @param {string} ch */
function textOf(chars, ch) {
  return ch.repeat(Math.max(0, chars))
}

/**
 * A host-shaped session that keeps its own surface and feeds every event to the projection, the
 * way test/fixtures/sim.js does. The extra bookkeeping is what the properties need: fold records
 * with their measurements, and replace-edge counters so a test can prove the generator reaches
 * the interesting cases.
 */
class Stream {
  constructor() {
    /** @type {SessionEvent[]} */
    this.events = []
    /** @type {number[]} */
    this.nodes = []
    /** @type {Map<number, SessionEvent>} */
    this.bySeq = new Map()
    /** @type {State} */
    this.state = initialState()
    this.seq = 0
    this.callNo = 0
    this.titleNo = 0
    /** @type {FoldRecord[]} */
    this.folds = []
    /**
     * Replace edges the generated streams actually reach. `foldedTasks` counts the §4 fold
     * special case (a replacement that exactly covers a waiting span), `absorbedCuts` and
     * `reanchoredCuts` count the two §2.4 outcomes, `boundaryReplacements` counts replacements
     * whose range edge is a tracked cut, `endSpansSwallowed` counts a closed task whose end cut a
     * later non-fold replacement removed, and `foldNodesSwallowed` counts an auto compaction that
     * shadowed a previous fold's replacement node.
     */
    this.stats = {
      foldedTasks: 0,
      reanchoredCuts: 0,
      absorbedCuts: 0,
      untouchedTasks: 0,
      boundaryReplacements: 0,
      endSpansSwallowed: 0,
      foldNodesSwallowed: 0,
    }
    this.push({
      type: 'system/message',
      data: { role: 'system', content: [{ type: 'text', text: 'system' }] },
      surfaceOp: 'append',
    })
  }

  /**
   * @param {Omit<SessionEvent, 'seq'>} partial
   * @returns {number}
   */
  push(partial) {
    /** @type {SessionEvent} */
    const event = { ...partial, seq: this.seq++ }
    this.events.push(event)
    this.bySeq.set(event.seq, event)
    const before = this.state
    const change = SURFACE_TYPES.has(event.type) ? applySurfaceOp(this.nodes, event) : null
    this.state = apply(before, event)
    if (change !== null && isReplaceEvent(event)) this.observeReplace(event, before, change)
    return event.seq
  }

  /**
   * Record what one replacement did to the tracked cuts (for the edge-coverage test) and keep the
   * surface change itself out of the state.
   *
   * @param {SessionEvent} event
   * @param {State} before
   * @param {{ removed: number[], startIndex: number }} change
   */
  observeReplace(event, before, change) {
    const op = replaceOpOf(event)
    const replacementSeq = event.seq
    const removed = new Set(change.removed)
    for (const id of before.order) {
      const task = before.tasks[id]
      if (!task) continue
      const cutValues = [task.beginCut, task.spanStart, task.endCut]
      if (cutValues.some((cut) => cut === op.startSeq || cut === op.endSeq)) {
        this.stats.boundaryReplacements += 1
      }
      const foldCase =
        event.type === 'user/message' &&
        before.pendingSummary !== null &&
        WAITING.has(task.status) &&
        task.spanStart === op.startSeq &&
        task.endCut === op.endSeq
      if (foldCase) {
        this.stats.foldedTasks += 1
        continue
      }
      if (TERMINAL.has(task.status)) continue
      const after = this.state.tasks[id]
      if (!after) continue
      const nextCuts = [after.beginCut, after.spanStart, after.endCut]
      if (nextCuts.every((cut, i) => cut === cutValues[i])) this.stats.untouchedTasks += 1
      for (let i = 0; i < cutValues.length; i++) {
        const cut = cutValues[i]
        const next = nextCuts[i]
        if (cut === next) continue
        if (next === replacementSeq) this.stats.reanchoredCuts += 1
        else if (next === ABSORBED) this.stats.absorbedCuts += 1
      }
      // A closed task whose end cut a non-fold replacement removed: its span was swallowed later.
      if (WAITING.has(task.status) && task.endCut !== null && removed.has(task.endCut)) {
        this.stats.endSpansSwallowed += 1
      }
    }
    for (const row of before.folds) {
      if (row.nodeSeq !== null && removed.has(row.nodeSeq)) {
        this.stats.foldNodesSwallowed += 1
        break
      }
    }
  }

  /** @param {string} [text] @param {any} [source] */
  user(text = 'user text', source = { kind: 'user' }) {
    return this.push({
      type: 'user/message',
      data: { role: 'user', content: [{ type: 'text', text }], source },
      surfaceOp: 'append',
    })
  }

  /** @param {string} key */
  hint(key) {
    return this.user(`hint ${key}`, { kind: 'task-folding:hint', key })
  }

  header() {
    return this.push({
      type: 'request/header',
      data: { header: { tools: [], config: {} }, reason: 'initial' },
    })
  }

  stepEnd() {
    return this.push({ type: 'step/end', data: {} })
  }

  /**
   * An assistant message with the given calls; returns the message seq and call ids.
   *
   * @param {{ name: string, args?: object }[]} calls
   * @param {number} [chars] padding so span token estimates vary between cases
   */
  assistant(calls = [], chars = 0) {
    const ids = calls.map(() => `call_${this.callNo++}`)
    const content = [
      { type: 'text', text: chars > 0 ? textOf(chars, 'a') : 'thinking' },
      ...calls.map((call, i) => ({
        type: 'tool-call',
        id: at(ids, i),
        name: call.name,
        arguments: JSON.stringify(call.args || {}),
      })),
    ]
    const seq = this.push({
      type: 'assistant/message',
      data: { message: { role: 'assistant', content, source: { kind: 'model' } } },
      surfaceOp: 'append',
    })
    return { seq, ids }
  }

  /**
   * @param {string} callId
   * @param {{ meta?: unknown, isError?: boolean, name?: string, chars?: number }} [options]
   */
  result(callId, options = {}) {
    const callSeq = this.push({ type: 'tool/call', data: { callId, name: options.name || 'tool' } })
    /** @type {Record<string, unknown>} */
    const data = {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId },
        toolCallId: callId,
        content: [{ type: 'text', text: textOf(options.chars ?? 0, 'r') || 'result' }],
        isError: Boolean(options.isError),
      },
    }
    if (options.meta !== undefined) data.meta = options.meta
    return this.push({ type: 'tool/result', data, surfaceOp: 'append', sourceEventSeqs: [callSeq] })
  }

  /**
   * One batch: an assistant message with these calls, then each call executed in order, the way
   * the native executor does, with task-tool meta computed at execution time. Copied from
   * Sim.batch (test/fixtures/sim.js); `drop` leaves trailing results unanswered and `repair`
   * then closes them with synthetic error results, as the host's session repair does.
   *
   * @param {CallSpec[]} specs
   * @param {{ stepEnd?: boolean, drop?: number, repair?: boolean, chars?: number }} [options]
   */
  batch(specs, options = {}) {
    const { seq, ids } = this.assistant(
      specs.map((spec) => ({ name: callName(spec) })),
      options.chars ?? 0,
    )
    const deliver = specs.length - (options.drop || 0)
    for (let i = 0; i < deliver; i++) {
      const spec = /** @type {CallSpec} */ (specs[i])
      const id = /** @type {string} */ (ids[i])
      if (spec.kind === 'begin') this.result(id, { meta: this.beginMeta(spec), name: 'task_begin' })
      else if (spec.kind === 'end') {
        const meta = this.endMeta(spec, id)
        this.result(id, meta ? { meta, name: 'task_end' } : { isError: true, name: 'task_end' })
      } else {
        this.result(id, {
          isError: Boolean(spec.error),
          name: spec.name || 'read',
          chars: spec.chars ?? options.chars ?? 0,
        })
      }
    }
    if (options.repair) {
      for (const id of ids.slice(deliver)) this.result(id, { isError: true, name: 'interrupted' })
    }
    if (options.stepEnd !== false) this.stepEnd()
    return { seq, ids }
  }

  /** @param {{ title?: string }} spec */
  beginMeta(spec) {
    const open = this.state.open
    return {
      tf: 1,
      op: 'begin',
      id: `T${this.state.nextId}`,
      title: spec.title || `task ${this.titleNo++}`,
      parent: open.length > 0 ? open[open.length - 1] : null,
    }
  }

  /**
   * Mirrors task_end: closes the named or innermost open task and its open descendants.
   * Returns null when the call would fail (no open task, unknown id).
   *
   * @param {{ id?: string, verdict?: EndVerdict }} spec
   * @param {string} callId
   */
  endMeta(spec, callId) {
    const open = this.state.open
    const id = spec.id !== undefined ? spec.id : open[open.length - 1]
    if (id === undefined || !open.includes(id)) return null
    const task = /** @type {Task} */ (this.state.tasks[id])
    const merged = open.slice(open.indexOf(id) + 1)
    /** @type {EndVerdict} */
    let verdict = spec.verdict || 'queued'
    if (task.beginCut === ABSORBED) verdict = 'absorbed'
    return {
      tf: 1,
      op: 'end',
      id,
      merged,
      verdict,
      outcome: 'done',
      estTokens: 5000,
      summaryChars: 400,
      callId,
    }
  }

  /** @param {number} [n] @param {number} [calls] @param {number} [chars] */
  work(n = 1, calls = 1, chars = 0) {
    for (let i = 0; i < n; i++) {
      this.batch(
        Array.from({ length: calls }, () => ({ kind: /** @type {const} */ ('other'), chars })),
        { chars },
      )
    }
  }

  /** @param {string} [title] */
  begin(title) {
    return this.batch([{ kind: 'begin', ...(title === undefined ? {} : { title }) }])
  }

  /** @param {{ id?: string, verdict?: EndVerdict }} [spec] */
  end(spec = {}) {
    return this.batch([{ kind: 'end', ...spec }])
  }

  /** Model text after a batch; also the gate that makes closed tasks due. */
  say(chars = 0) {
    return this.assistant([], chars)
  }

  /**
   * A host compaction transaction replacing the inclusive surface range start..end by one node.
   * Copied from Sim.compact (test/fixtures/sim.js); the summary text is a parameter here because
   * property 7 needs a replacement that respects the host's "not smaller than the span" refusal.
   *
   * @param {number} startSeq
   * @param {number} endSeq
   * @param {string} [summaryText]
   */
  compact(startSeq, endSeq, summaryText = 'summary') {
    const i = this.nodes.indexOf(startSeq)
    const j = this.nodes.indexOf(endSeq)
    if (i === -1 || j === -1 || i > j) throw new Error(`invariants: cannot compact ${startSeq}..${endSeq}`)
    const shadowed = this.nodes.slice(i, j + 1)
    const compactionId = `c${this.seq}`
    const startEv = this.push({ type: 'compaction/start', data: { compactionId, turn: 1 } })
    const summaryEv = this.push({
      type: 'compaction/summary',
      data: {
        compactionId,
        summary: [{ type: 'text', text: 'summary' }],
        shadowedSeqs: shadowed,
        shadowedRange: { start: startSeq, end: endSeq },
        shadowedTokenCount: shadowed.length * 100,
      },
    })
    const node = this.push({
      type: 'user/message',
      data: {
        role: 'user',
        content: [{ type: 'text', text: summaryText }],
        source: { kind: 'compact-checkpoint' },
      },
      surfaceOp: { op: 'replace', startSeq, endSeq },
      sourceEventSeqs: [startEv, summaryEv, ...shadowed],
    })
    this.push({ type: 'compaction/end', data: { compactionId } })
    return node
  }

  /**
   * Auto compaction of the oldest `count` nodes after the system message, snapped to a balanced
   * end. Copied from Sim.compactHead.
   *
   * @param {number} count
   */
  compactHead(count) {
    const candidates = this.nodes.slice(1)
    let end = Math.min(count, candidates.length) - 1
    while (end >= 0 && !this.balancedRange(1, end + 1)) end--
    if (end < 0) return null
    return this.compact(at(this.nodes, 1), at(this.nodes, end + 1))
  }

  /**
   * The tool-result pruner: replaces one result, keeping its data (including meta). Copied from
   * Sim.prune.
   *
   * @param {number} seq
   */
  prune(seq) {
    const original = this.bySeq.get(seq)
    if (!original || original.type !== 'tool/result')
      throw new Error(`invariants: ${seq} is not a tool result`)
    this.push({
      type: 'compaction/prune',
      data: {
        shadowedSeqs: [seq],
        shadowedRange: { start: seq, end: seq },
        shadowedTokenCount: 100,
      },
    })
    return this.push({
      type: 'tool/result',
      data: original.data,
      surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
      sourceEventSeqs: [seq],
    })
  }

  failCompaction() {
    const compactionId = `c${this.seq}`
    this.push({ type: 'compaction/start', data: { compactionId, turn: 1 } })
    return this.push({ type: 'compaction/end', data: { compactionId, error: { message: 'failed' } } })
  }

  /**
   * Fold one closed task through the real planner, re-reading it from the projection first: the
   * runner does the same after every committed fold, because an inner fold moves the outer task's
   * cuts (docs/03 §5.3). Returns the replacement seq, or null when the task is not foldable.
   *
   * The summary text is sized so its estimate never exceeds the replaced region's estimate: the
   * host refuses a summary that is not smaller than the shadowed content (§5.3 step 6), and
   * property 7 then checks that the estimate of the surface after the fold never grew.
   *
   * @param {string} id
   * @param {number} requestedChars
   * @returns {number | null}
   */
  fold(id, requestedChars) {
    const task = this.state.tasks[id]
    if (!task || !WAITING.has(task.status)) return null
    const region = resolveRegion(task, this.nodes)
    if (region.kind !== 'fold') return null
    const nodesBefore = this.nodes.slice()
    const beforeSession = sessionOf(this, nodesBefore)
    const beforeEstimator = new SpanEstimator(meter)
    const spanBefore = beforeEstimator.span(beforeSession, task)
    const regionTokens = beforeEstimator.regionTokens(
      beforeSession,
      nodesBefore,
      region.startIndex,
      region.endIndex,
    )
    const surfaceBefore = beforeEstimator.regionTokens(beforeSession, nodesBefore, 0, nodesBefore.length - 1)
    /** @type {{ id: string, before: number }[]} */
    const ancestors = []
    let ancestorOpen = false
    let parentId = task.parent
    while (parentId !== null) {
      const parent = this.state.tasks[parentId]
      if (!parent) break
      if (parent.status === 'open' || parent.status === 'opening') {
        ancestorOpen = true
        const before = new SpanEstimator(meter).span(beforeSession, parent)
        if (before >= 0) ancestors.push({ id: parent.id, before })
      }
      parentId = parent.parent
    }
    const allowedChars = Math.max(1, 4 * regionTokens)
    const summaryText = textOf(Math.min(Math.max(1, requestedChars), allowedChars), 's')
    const replacementSeq = this.compact(region.start, region.end, summaryText)
    const nodesAfter = this.nodes.slice()
    const afterSession = sessionOf(this, nodesAfter)
    const afterEstimator = new SpanEstimator(meter)
    const afterTask = this.state.tasks[id]
    const spanAfter = afterTask ? afterEstimator.span(afterSession, afterTask) : -1
    const summaryTokens = afterEstimator.node(afterSession, replacementSeq)
    const surfaceAfter = afterEstimator.regionTokens(afterSession, nodesAfter, 0, nodesAfter.length - 1)
    /** @type {{ id: string, before: number, after: number }[]} */
    const measurableAncestors = []
    for (const ancestor of ancestors) {
      const current = this.state.tasks[ancestor.id]
      if (!current) continue
      const after = new SpanEstimator(meter).span(afterSession, current)
      if (after >= 0) measurableAncestors.push({ id: ancestor.id, before: ancestor.before, after })
    }
    this.folds.push({
      taskId: id,
      start: region.start,
      end: region.end,
      startIndex: region.startIndex,
      endIndex: region.endIndex,
      nodesBefore,
      nested: task.parent !== null,
      ancestorOpen,
      spanBefore,
      spanAfter,
      regionTokens,
      summaryTokens,
      surfaceBefore,
      surfaceAfter,
      ancestors: measurableAncestors,
    })
    return replacementSeq
  }

  /**
   * Fold every waiting task that the planner can still resolve, inner-first like the runner's
   * turn-stopping pass. Re-reads the state after each committed fold.
   *
   * @param {number} chars
   */
  foldAll(chars) {
    let folded = 0
    for (;;) {
      const due = dueTasks(this.state, { turnStopping: true })
      if (due.length === 0) break
      let progressed = false
      for (const candidate of due) {
        if (this.fold(candidate.id, chars) !== null) {
          folded += 1
          progressed = true
        }
      }
      if (!progressed) break
    }
    return folded
  }

  /**
   * Reference tool-pairing check over surface positions [i, j] inclusive. Copied from
   * Sim.balancedRange.
   *
   * @param {number} i
   * @param {number} j
   */
  balancedRange(i, j) {
    const calls = new Set()
    const results = new Set()
    for (const seq of this.nodes.slice(i, j + 1)) {
      const event = this.bySeq.get(seq)
      if (!event) continue
      if (event.type === 'assistant/message') {
        const content = event.data?.message?.content
        if (Array.isArray(content)) {
          for (const block of content) if (block?.type === 'tool-call') calls.add(block.id)
        }
      } else if (event.type === 'tool/result') {
        const callId = event.data?.message?.toolCallId
        if (typeof callId === 'string') results.add(callId)
      }
    }
    if (calls.size !== results.size) return false
    for (const id of calls) if (!results.has(id)) return false
    return true
  }
}

/** @param {CallSpec} spec */
function callName(spec) {
  if (spec.kind === 'begin') return 'task_begin'
  if (spec.kind === 'end') return 'task_end'
  return spec.name || 'read'
}

// ---------------------------------------------------------------------------
// Generator kit: the operations a model and the host can perform, and their execution

const verdictArb = fc.constantFrom(
  /** @type {const} */ ('queued'),
  'queued',
  'queued',
  'delegate',
  'below-floor',
)

const cutKindArb = fc.constantFrom(/** @type {const} */ ('beginCut'), 'spanStart', 'endCut')

/**
 * The program a generated session runs. Weights send most cases through the edges the invariants
 * care about: nested begins, relays, folds of closed tasks (including folds inside a still-open
 * parent), head auto compaction, arbitrary range replacements, replacements whose range edge is a
 * tracked cut, pruner replacements and interrupted batches.
 */
const opArb = fc.oneof(
  { weight: 4, arbitrary: fc.constant({ t: 'begin' }) },
  { weight: 2, arbitrary: fc.constant({ t: 'beginEnd' }) },
  { weight: 2, arbitrary: fc.constant({ t: 'doubleBegin' }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('end'), verdict: verdictArb }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('relay'), verdict: verdictArb }) },
  {
    weight: 5,
    arbitrary: fc.record({
      t: fc.constant('work'),
      n: fc.integer({ min: 1, max: 2 }),
      calls: fc.integer({ min: 1, max: 3 }),
      chars: fc.integer({ min: 0, max: 120 }),
    }),
  },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('say'), chars: fc.integer({ min: 0, max: 200 }) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('hint'), key: fc.constantFrom('T1:25', 'T2:50') }) },
  { weight: 6, arbitrary: fc.record({ t: fc.constant('fold'), chars: fc.integer({ min: 1, max: 2000 }) }) },
  {
    weight: 4,
    arbitrary: fc.record({ t: fc.constant('taskRun'), chars: fc.integer({ min: 1, max: 800 }) }),
  },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('compactHead'), n: fc.integer({ min: 1, max: 40 }) }) },
  {
    weight: 3,
    arbitrary: fc.record({
      t: fc.constant('replaceRange'),
      a: fc.double({ min: 0, max: 1, noNaN: true }),
      b: fc.double({ min: 0, max: 1, noNaN: true }),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      t: fc.constant('replaceAtCut'),
      taskIndex: fc.nat({ max: 7 }),
      which: cutKindArb,
      side: fc.constantFrom(/** @type {const} */ ('forward'), 'backward'),
      delta: fc.integer({ min: 0, max: 3 }),
    }),
  },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('prune'), back: fc.integer({ min: 0, max: 8 }) }) },
  {
    weight: 1,
    arbitrary: fc.record({ t: fc.constant('interrupt'), begin: fc.boolean() }),
  },
  { weight: 1, arbitrary: fc.constant({ t: 'failCompaction' }) },
  { weight: 1, arbitrary: fc.constant({ t: 'header' }) },
)

const opsArb = fc.array(opArb, { minLength: 4, maxLength: 24 })

/**
 * @param {Stream} stream
 * @param {any} op
 */
function run(stream, op) {
  switch (op.t) {
    case 'begin':
      return stream.begin()
    case 'beginEnd':
      return stream.batch([{ kind: 'begin' }, { kind: 'other' }, { kind: 'end' }])
    case 'doubleBegin':
      return stream.batch([{ kind: 'begin' }, { kind: 'other' }, { kind: 'begin' }])
    case 'end':
      return stream.end({ verdict: op.verdict })
    case 'relay':
      return stream.batch([{ kind: 'end', verdict: op.verdict }, { kind: 'begin' }])
    case 'work':
      return stream.work(op.n, op.calls, op.chars)
    case 'say':
      return stream.say(op.chars)
    case 'hint':
      return stream.hint(op.key)
    case 'fold':
      return stream.foldAll(op.chars)
    case 'taskRun': {
      // One whole task lifecycle, so every stream has at least a chance of a committed fold; if a
      // parent is already open the task nests, which is the "fold inside an open parent" edge.
      stream.begin()
      stream.work(1, 2, op.chars)
      stream.say()
      stream.end()
      stream.say()
      return stream.foldAll(op.chars)
    }
    case 'compactHead':
      return stream.compactHead(op.n)
    case 'replaceRange':
      return replaceRange(stream, op)
    case 'replaceAtCut':
      return replaceAtCut(stream, op)
    case 'prune':
      return pruneOne(stream, op.back)
    case 'interrupt':
      return stream.batch([op.begin ? { kind: 'begin' } : { kind: 'other' }, { kind: 'other' }], {
        drop: 1,
        repair: true,
      })
    case 'failCompaction':
      return stream.failCompaction()
    case 'header':
      return stream.header()
    default:
      return
  }
}

/**
 * A replacement over a range whose position is derived from two generated shares of the current
 * surface. Index 0 is the system message, which no host compaction shadows.
 *
 * @param {Stream} stream
 * @param {{ a: number, b: number }} op
 */
function replaceRange(stream, op) {
  const nodes = stream.nodes
  const last = nodes.length - 1
  if (last < 1) return
  const first = Math.min(last, 1 + Math.floor(op.a * last))
  const second = Math.min(last, 1 + Math.floor(op.b * last))
  const lo = Math.min(first, second)
  const hi = Math.max(first, second)
  stream.compact(at(nodes, lo), at(nodes, hi), textOf(80, 's'))
}

/**
 * A replacement whose range edge is exactly a tracked cut, grown toward one side: this is the
 * "replace touching a cut exactly at its boundary" edge (a head compaction ending on the cut, or a
 * pruner replacing the cut node itself).
 *
 * @param {Stream} stream
 * @param {{ taskIndex: number, which: 'beginCut' | 'spanStart' | 'endCut', side: 'forward' | 'backward', delta: number }} op
 */
function replaceAtCut(stream, op) {
  const { order } = stream.state
  if (order.length === 0) return
  const id = at(order, op.taskIndex % order.length)
  const task = stream.state.tasks[id]
  if (!task) return
  const cut = task[op.which]
  if (cut === null || cut === ABSORBED) return
  const index = stream.nodes.indexOf(cut)
  if (index < 1) return
  const lo = op.side === 'forward' ? index : Math.max(1, index - op.delta)
  const hi = op.side === 'forward' ? Math.min(stream.nodes.length - 1, index + op.delta) : index
  if (lo > hi) return
  stream.compact(at(stream.nodes, lo), at(stream.nodes, hi), textOf(80, 's'))
}

/**
 * Replace one tool result, the pruner's move. Copied from ops.js.
 *
 * @param {Stream} stream
 * @param {number} back
 */
function pruneOne(stream, back) {
  const results = stream.nodes.filter((seq) => stream.bySeq.get(seq)?.type === 'tool/result')
  const seq = results[results.length - 1 - back]
  if (seq === undefined) return
  stream.prune(seq)
}

/** @param {readonly any[]} ops */
function materialize(ops) {
  const stream = new Stream()
  stream.user('initial question')
  for (const op of ops) run(stream, op)
  return stream
}

/**
 * @param {readonly SessionEvent[]} events
 * @param {State} [from]
 */
function replay(events, from = init({}, 0)) {
  return events.reduce(apply, from)
}

// ---------------------------------------------------------------------------
// Reference oracles: the rules as the design states them, not calls into the code under test

/**
 * host/fold-runner.js regionKeyOf, re-derived from its source. The function is not exported and
 * host/* is out of scope for this milestone, so the rule is reproduced here verbatim:
 *
 *   const seqs = []
 *   for (let i = region.startIndex; i <= region.endIndex; i++) seqs.push(String(nodes[i]))
 *   return `${region.start}:${region.end}:${seqs.join(',')}`
 *
 * Property 6 asserts the *rule* ("a function of the region's nodes only"), not this copy.
 *
 * @param {FoldRegion} region
 * @param {readonly number[]} nodes
 * @returns {string}
 */
function regionKeyOf(region, nodes) {
  /** @type {string[]} */
  const seqs = []
  for (let i = region.startIndex; i <= region.endIndex; i++) seqs.push(String(nodes[i]))
  return `${region.start}:${region.end}:${seqs.join(',')}`
}

/**
 * How docs/03 §4's replace row treats one task: a terminal task is frozen, a waiting task whose
 * span the replacement covers exactly is the fold special case, everything else is translated by
 * §2.4.
 *
 * @param {Task} task
 * @param {SessionEvent} event
 * @param {number | null} pendingSummary
 * @returns {'frozen' | 'folded' | 'translated'}
 */
function treatmentOf(task, event, pendingSummary) {
  if (TERMINAL.has(task.status)) return 'frozen'
  const op = replaceOpOf(event)
  const folded =
    event.type === 'user/message' &&
    pendingSummary !== null &&
    WAITING.has(task.status) &&
    task.spanStart !== null &&
    task.spanStart !== ABSORBED &&
    task.endCut !== null &&
    task.endCut !== ABSORBED &&
    task.spanStart === op.startSeq &&
    task.endCut === op.endSeq
  return folded ? 'folded' : 'translated'
}

/**
 * docs/03 §2.4 "after(s)": a cut survives only when it followed the last shadowed node.
 *
 * @param {number | null} cut
 * @param {Set<number>} shadowed
 * @param {import('../host/types.js').ReplaceOp} op
 * @param {number} replacementSeq
 * @returns {number | null}
 */
function afterCut(cut, shadowed, op, replacementSeq) {
  if (cut === null || cut === ABSORBED || !shadowed.has(cut)) return cut
  return cut === op.endSeq ? replacementSeq : ABSORBED
}

/**
 * docs/03 §2.4 "first(s)": a span start survives only when the replacement starts exactly at it.
 *
 * @param {number | null} cut
 * @param {Set<number>} shadowed
 * @param {import('../host/types.js').ReplaceOp} op
 * @param {number} replacementSeq
 * @returns {number | null}
 */
function firstCut(cut, shadowed, op, replacementSeq) {
  if (cut === null || cut === ABSORBED || !shadowed.has(cut)) return cut
  return cut === op.startSeq ? replacementSeq : ABSORBED
}

// ---------------------------------------------------------------------------
// Fixed seed and failure messages

// One fixed seed for every property: the whole file is deterministic, so the failing case in a
// report is reproducible by re-running the suite on that revision. fast-check prints the seed and
// the shrunk counterexample; every assertion below also carries the raw generated program.
const SEED = 20261121

/**
 * A failure message that carries the exact seed and the whole generated program.
 *
 * @param {readonly any[]} ops
 */
function where(ops) {
  return `\n  seed: ${SEED}\n  ops: ${JSON.stringify(ops)}`
}

/**
 * Shared assertion settings: 200 cases per property by default.
 *
 * @param {number} [numRuns]
 */
function settings(numRuns = 200) {
  return { numRuns, seed: SEED, verbose: fc.VerbosityLevel.None }
}

// ---------------------------------------------------------------------------
// The eight invariants

test('1. cuts are monotone: appends never move a cut backwards, a span never ends before it starts', () => {
  fc.assert(
    fc.property(opsArb, (ops) => {
      const stream = materialize(ops)
      /** @type {number[]} */
      const nodes = []
      let state = init({}, 0)
      for (const event of stream.events) {
        if (SURFACE_TYPES.has(event.type)) applySurfaceOp(nodes, event)
        const before = state
        state = apply(state, event)
        const replaced = isReplaceEvent(event)
        if (!replaced && state === before) continue
        if (!replaced) {
          // An append (or a non-surface event) can only reveal or advance a cut, never rewind it.
          for (const id of before.order) {
            const previous = before.tasks[id]
            const current = state.tasks[id]
            if (!previous || !current) continue
            for (const key of /** @type {const} */ (['beginCut', 'spanStart'])) {
              const old = previous[key]
              const next = current[key]
              if (typeof old === 'number' && old >= 0 && typeof next === 'number' && next >= 0) {
                assert.ok(next >= old, `${id}.${key} moved backwards from ${old} to ${next}${where(ops)}`)
              }
            }
          }
        }
        // Ordering is checked in surface order, not by seq: a replacement reuses the shadowed
        // node's position with a fresh (larger) seq, so seq order is allocation order, not
        // surface order. The planner works on positions (docs/03 §5.2), and so does this.
        for (const id of state.order) {
          const task = state.tasks[id]
          if (!task) continue
          const { spanStart, endCut } = task
          if (spanStart === null || endCut === null) continue
          if (spanStart === ABSORBED || endCut === ABSORBED) continue
          const startIndex = nodes.indexOf(spanStart)
          const endIndex = nodes.indexOf(endCut)
          if (startIndex === -1 || endIndex === -1) continue
          assert.ok(
            endIndex >= startIndex,
            `${id} ends before it starts: spanStart at surface ${startIndex}, endCut at ${endIndex}${where(ops)}`,
          )
        }
      }
    }),
    settings(),
  )
})

test('2. apply is deterministic and idempotent; parseState accepts every produced state', () => {
  fc.assert(
    fc.property(opsArb, (ops) => {
      const stream = materialize(ops)
      // Replaying the whole log twice yields deep-equal states, and equals the state the stream
      // built event by event: the reducer has no hidden input besides its arguments.
      const once = replay(stream.events)
      const twice = replay(stream.events)
      assert.deepEqual(twice, once, `a second replay of the same log differs${where(ops)}`)
      assert.deepEqual(once, stream.state, `incremental and batch replay differ${where(ops)}`)

      // Every state the sequence produces is accepted by the real schema. The JSON encoding the
      // host checkpoints is exercised once per case, on the final state (property 8 round-trips a
      // mid-log checkpoint).
      let state = init({}, 0)
      for (const event of stream.events) {
        state = apply(state, event)
        assert.doesNotThrow(
          () => parseState(state),
          `parseState rejected the state after ${event.type}@${event.seq}${where(ops)}`,
        )
      }
      assert.deepEqual(
        parseState(JSON.parse(JSON.stringify(once))),
        once,
        `the checkpoint encoding changed the final state${where(ops)}`,
      )
    }),
    settings(),
  )
})

test('3. stack/table consistency: open, order and tasks agree about every task', () => {
  fc.assert(
    fc.property(opsArb, (ops) => {
      const stream = materialize(ops)
      let state = init({}, 0)
      checkTables(state, ops)
      for (const event of stream.events) {
        const before = state
        state = apply(state, event)
        if (state !== before) checkTables(state, ops, event)
      }
    }),
    settings(),
  )
})

/**
 * @param {State} state
 * @param {readonly any[]} ops
 * @param {SessionEvent} [event]
 */
function checkTables(state, ops, event) {
  const at1 = event ? ` after ${event.type}@${event.seq}` : ''
  const suffix = `${at1}${where(ops)}`
  assert.equal(new Set(state.order).size, state.order.length, `duplicate id in order${suffix}`)
  assert.equal(new Set(state.open).size, state.open.length, `duplicate id in open${suffix}`)
  assert.deepEqual(
    Object.keys(state.tasks).sort(),
    [...state.order].sort(),
    `tasks and order disagree${suffix}`,
  )
  for (const id of state.open) {
    const task = state.tasks[id]
    assert.ok(task, `open id ${id} has no task${suffix}`)
    assert.ok(
      task.status === 'open' || task.status === 'opening',
      `open id ${id} has status ${task.status}${suffix}`,
    )
  }
  for (const id of state.order) {
    const task = state.tasks[id]
    assert.ok(task, `order id ${id} has no task${suffix}`)
    const match = /^T([1-9][0-9]*)$/.exec(id)
    assert.ok(match, `task id ${id} is not a task ordinal${suffix}`)
    assert.ok(state.nextId > Number(match[1]), `nextId ${state.nextId} does not exceed ${id}${suffix}`)
  }
  // open is the still-open chain, outermost first, exactly in creation order.
  const live = state.order.filter((id) => {
    const status = state.tasks[id]?.status
    return status === 'open' || status === 'opening'
  })
  assert.deepEqual(state.open, live, `open is not the open-chain stack${suffix}`)
  for (let i = 1; i < state.open.length; i++) {
    const child = state.tasks[at(state.open, i)]
    assert.ok(child, `open child ${at(state.open, i)} has no task${suffix}`)
    assert.equal(
      child.parent,
      at(state.open, i - 1),
      `open stack breaks the parent chain at ${child.id}${suffix}`,
    )
  }
}

test('4. surfaceOp.replace translates every cut exactly once, per docs §2.4 and §4', () => {
  fc.assert(
    fc.property(opsArb, (ops) => {
      const stream = materialize(ops)
      /** @type {number[]} */
      const nodes = []
      let state = init({}, 0)
      for (const event of stream.events) {
        if (SURFACE_TYPES.has(event.type)) applySurfaceOp(nodes, event)
        const before = state
        state = apply(state, event)
        if (!isReplaceEvent(event)) continue
        checkReplace(before, state, event, ops)
      }
    }),
    settings(),
  )
})

/**
 * @param {State} before
 * @param {State} after
 * @param {SessionEvent} event
 * @param {readonly any[]} ops
 */
function checkReplace(before, after, event, ops) {
  const op = replaceOpOf(event)
  const replacementSeq = event.seq
  const shadowed = new Set(event.sourceEventSeqs ?? [])
  for (const id of before.order) {
    const task = before.tasks[id]
    const next = after.tasks[id]
    if (!task || !next) continue
    const treatment = treatmentOf(task, event, before.pendingSummary)
    /** @type {(number | null)[]} */
    const expected =
      treatment === 'translated'
        ? [
            afterCut(task.beginCut, shadowed, op, replacementSeq),
            firstCut(task.spanStart, shadowed, op, replacementSeq),
            afterCut(task.endCut, shadowed, op, replacementSeq),
          ]
        : [task.beginCut, task.spanStart, task.endCut]
    const actual = [next.beginCut, next.spanStart, next.endCut]
    assert.deepEqual(
      actual,
      expected,
      `${id}: cuts after replacing ${op.startSeq}..${op.endSeq} with ${replacementSeq} (${treatment})${where(ops)}`,
    )
    // No cut may land anywhere else: not a shifted twice value, not a stale one. Every output is
    // the old value, the absorbed sentinel, or the replacement's seq.
    const origin = [task.beginCut, task.spanStart, task.endCut]
    for (let i = 0; i < origin.length; i++) {
      const value = at(actual, i)
      const old = at(origin, i)
      assert.ok(
        value === old || value === ABSORBED || value === replacementSeq,
        `${id} cut ${i} became ${value}, which is neither its old value, ABSORBED, nor ${replacementSeq}${where(ops)}`,
      )
    }
    // A task none of whose cuts was shadowed keeps its cuts byte-for-byte (and its object: the
    // reducer returns the same task reference when nothing moved).
    const untouched = origin.every((cut) => cut === null || cut === ABSORBED || !shadowed.has(cut))
    if (untouched && treatment !== 'folded') {
      assert.equal(next, task, `${id} has no shadowed cut but was rebuilt${where(ops)}`)
    }
  }
}

test('5. every fold shadows only nodes that were on the surface of the region it replaced', () => {
  fc.assert(
    fc.property(opsArb, (ops) => {
      const stream = materialize(ops)
      /** @type {number[]} */
      const nodes = []
      /** @type {SessionEvent[]} */
      const summaries = []
      /** @type {SessionEvent[]} */
      const pending = []
      let state = init({}, 0)
      for (const event of stream.events) {
        if (event.type === 'compaction/summary') {
          summaries.push(event)
          pending.push(event)
        }
        const change = SURFACE_TYPES.has(event.type) ? applySurfaceOp(nodes, event) : null
        state = apply(state, event)
        if (change === null || !isReplaceEvent(event)) continue
        // A replacement without a pending summary is the pruner: it has no fold row and no
        // shadowed surface claim to check.
        if (pending.length === 0) continue
        const summary = /** @type {SessionEvent} */ (pending.shift())
        const data = summary.data || {}
        const shadowed = Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs : []
        const removed = new Set(change.removed)
        const op = replaceOpOf(event)
        for (const seq of shadowed) {
          assert.ok(
            removed.has(seq),
            `fold #${summaries.length - 1} shadows ${seq}, which is not in the replaced region ${op.startSeq}..${op.endSeq}${where(ops)}`,
          )
        }
        if (data.shadowedRange) {
          assert.deepEqual(
            data.shadowedRange,
            { start: op.startSeq, end: op.endSeq },
            `fold #${summaries.length - 1} describes a different range than it replaced${where(ops)}`,
          )
        }
      }
      assert.equal(pending.length, 0, `a generated fold never received its replacement${where(ops)}`)
      // The reducer keeps one row per summary, with the shadowed count the fold reported.
      assert.equal(state.folds.length, summaries.length, `fold rows do not match summaries${where(ops)}`)
      for (let i = 0; i < summaries.length; i++) {
        const data = summaries[i]?.data || {}
        const shadowed = Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs : []
        assert.equal(
          at(state.folds, i).shadowedCount,
          shadowed.length,
          `fold row ${i} lost its count${where(ops)}`,
        )
      }
    }),
    settings(),
  )
})

/**
 * Evenly spaced offsets into a region, always including both boundary nodes.
 *
 * @param {number} length
 * @param {number} count
 * @returns {number[]}
 */
function sampleOffsets(length, count) {
  const offsets = new Set([0, length - 1])
  for (let i = 1; i < count - 1; i++) offsets.add(Math.round((i * (length - 1)) / (count - 1)))
  return [...offsets].sort((a, b) => a - b)
}

test('6. the region key is a function of the region’s nodes only', () => {
  const freshArb = fc.array(fc.integer({ min: 1_000_000, max: 2_000_000 }), {
    minLength: 1,
    maxLength: 64,
  })
  fc.assert(
    fc.property(opsArb, freshArb, (ops, fresh) => {
      const stream = materialize(ops)
      /** @type {{ region: FoldRegion, nodes: readonly number[] }[]} */
      const candidates = stream.folds.slice(0, 3).map((fold) => ({
        region: {
          kind: 'fold',
          start: fold.start,
          end: fold.end,
          startIndex: fold.startIndex,
          endIndex: fold.endIndex,
        },
        nodes: fold.nodesBefore,
      }))
      // Keep the property non-vacuous even for a stream where nothing was foldable: the final
      // surface is a region too, and the rule does not depend on the region coming from a fold.
      if (stream.nodes.length >= 2) {
        candidates.push({
          region: {
            kind: 'fold',
            start: at(stream.nodes, 0),
            end: at(stream.nodes, stream.nodes.length - 1),
            startIndex: 0,
            endIndex: stream.nodes.length - 1,
          },
          nodes: stream.nodes.slice(),
        })
      }
      for (const { region, nodes } of candidates) {
        const base = regionKeyOf(region, nodes)
        // Appending nodes after the region does not change it (the bug this property exists for).
        assert.equal(
          regionKeyOf(region, [...nodes, ...fresh]),
          base,
          `appending after the region changed its key${where(ops)}`,
        )
        // Nor do nodes outside the region: the key reads the slice, not the array around it.
        const outside = nodes.slice()
        for (let i = 0; i < outside.length; i++) {
          if (i < region.startIndex || i > region.endIndex) outside[i] = at(fresh, i % fresh.length)
        }
        assert.equal(
          regionKeyOf(region, outside),
          base,
          `changing nodes outside the region changed its key${where(ops)}`,
        )
        // Replacing a node inside the region does change it, boundaries included. Long regions
        // are sampled (both edges always included) so the property stays within its time budget.
        const length = region.endIndex - region.startIndex + 1
        const offsets = length <= 24 ? Array.from({ length }, (_, i) => i) : sampleOffsets(length, 24)
        for (const offset of offsets) {
          const inside = nodes.slice()
          inside[region.startIndex + offset] = at(fresh, offset % fresh.length)
          assert.notEqual(
            regionKeyOf(region, inside),
            base,
            `replacing region node ${region.startIndex + offset} did not change its key${where(ops)}`,
          )
        }
      }
    }),
    settings(),
  )
})

test('7. replacing a span by its summary never grows the span estimate', () => {
  fc.assert(
    fc.property(opsArb, (ops) => {
      const stream = materialize(ops)
      for (const fold of stream.folds) {
        const suffix = `${fold.taskId} folding ${fold.start}..${fold.end}${where(ops)}`
        assert.ok(fold.regionTokens > 0, `the replaced region estimated as empty: ${suffix}`)
        assert.ok(
          fold.summaryTokens <= fold.regionTokens,
          `the generator committed a summary larger than its span (${fold.summaryTokens} > ${fold.regionTokens}): ${suffix}`,
        )
        assert.ok(
          fold.regionTokens <= fold.spanBefore,
          `span estimate excludes part of the region: ${suffix}`,
        )
        assert.ok(fold.spanBefore >= 0, `the span had no estimate before the fold: ${suffix}`)
        assert.ok(fold.spanAfter >= 0, `the span had no estimate after the fold: ${suffix}`)
        assert.ok(
          fold.spanAfter <= fold.spanBefore,
          `the estimate grew over the fold: ${fold.spanBefore} -> ${fold.spanAfter}: ${suffix}`,
        )
        assert.ok(
          fold.surfaceAfter <= fold.surfaceBefore,
          `the whole-surface estimate grew over the fold: ${fold.surfaceBefore} -> ${fold.surfaceAfter}: ${suffix}`,
        )
        // An enclosing open task keeps the folded region inside its span; folding it can only
        // shrink that span's estimate (this is what makes folding worth doing at all).
        for (const ancestor of fold.ancestors) {
          assert.ok(
            ancestor.after <= ancestor.before,
            `${ancestor.id} grew over the fold of ${fold.taskId}: ${ancestor.before} -> ${ancestor.after}${where(ops)}`,
          )
        }
      }
    }),
    settings(),
  )
})

test('8. replay from a checkpoint at a random split equals the full replay', () => {
  const shareArb = fc.double({ min: 0, max: 1, noNaN: true })
  fc.assert(
    fc.property(opsArb, shareArb, (ops, share) => {
      const stream = materialize(ops)
      const events = stream.events
      const split = Math.min(events.length, Math.max(0, Math.floor(share * (events.length + 1))))
      const full = replay(events)
      // The projection's init contract: it ignores both the header and the inherited event count
      // because a checkpoint already contains the inherited prefix (host/projection.js init).
      const prefix = replay(events.slice(0, split), init({ inherited: true }, split))
      const checkpoint = parseState(JSON.parse(JSON.stringify(prefix)))
      assert.deepEqual(checkpoint, prefix, `the checkpoint encoding changed the resumed prefix${where(ops)}`)
      const resumed = replay(events.slice(split), checkpoint)
      assert.deepEqual(
        resumed,
        full,
        `resuming at ${split}/${events.length} differs from the full replay${where(ops)}`,
      )
      assert.deepEqual(full, stream.state, `the materialised state is not the replay state${where(ops)}`)
    }),
    settings(),
  )
})

// ---------------------------------------------------------------------------
// Non-vacuity guard: prove the generator reaches the edges the invariants are about

test('the generator reaches the design edges (a property without its interesting case proves nothing)', () => {
  /** @type {Record<string, number>} */
  const seen = {
    folds: 0,
    nestedFolds: 0,
    foldsInsideOpenParent: 0,
    foldedTasks: 0,
    reanchoredCuts: 0,
    absorbedCuts: 0,
    untouchedTasks: 0,
    boundaryReplacements: 0,
    endSpansSwallowed: 0,
    foldNodesSwallowed: 0,
  }
  fc.assert(
    fc.property(opsArb, (ops) => {
      const stream = materialize(ops)
      seen.folds = (seen.folds ?? 0) + stream.folds.length
      for (const fold of stream.folds) {
        if (fold.nested) seen.nestedFolds = (seen.nestedFolds ?? 0) + 1
        if (fold.ancestorOpen) seen.foldsInsideOpenParent = (seen.foldsInsideOpenParent ?? 0) + 1
      }
      for (const [edge, count] of Object.entries(stream.stats)) seen[edge] = (seen[edge] ?? 0) + count
      return true
    }),
    settings(140),
  )
  for (const [edge, count] of Object.entries(seen)) {
    assert.ok(count > 0, `the generator never produced the ${edge} case; widen the generator, not the test`)
  }
})

test('the surface epoch counts replacements and ignores appends', () => {
  // docs/10 §4.1: the epoch is the identity of the node list. Appending a node does not change any
  // existing node, so it must not move the version; a replacement does, even when no task is touched.
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 6 }), fc.integer({ min: 0, max: 3 }), (appends, replaces) => {
      let state = initialState()
      let seq = 0
      /** @type {number[]} */
      const nodes = []
      const append = () => {
        seq += 1
        nodes.push(seq)
        state = apply(state, { type: 'system/message', seq, data: {} })
      }
      append()
      const before = state.surfaceEpoch
      for (let i = 0; i < appends; i += 1) append()
      assert.equal(state.surfaceEpoch, before, 'an append does not move the epoch')
      for (let i = 0; i < replaces; i += 1) {
        const victim = /** @type {number} */ (nodes.pop())
        seq += 1
        nodes.push(seq)
        state = apply(state, {
          type: 'system/message',
          seq,
          data: {},
          surfaceOp: { op: 'replace', startSeq: victim, endSeq: victim },
        })
      }
      assert.equal(state.surfaceEpoch, before + replaces, 'each replacement moves it exactly once')
    }),
    { numRuns: 50, seed: 20261121 },
  )
})
