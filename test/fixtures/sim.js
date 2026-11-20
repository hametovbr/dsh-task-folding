// A small session simulator for tests: emits host-shaped events (docs/02-host-api.md §2),
// keeps a surface node list the way the host does, and feeds every event to the projection.
// It also emulates the task tools' meta so scenarios read like model behavior.

import { ABSORBED } from '../../host/cuts.js'
import { apply, initialState, TASK_TOOLS } from '../../host/projection.js'
import { resolveRegion } from '../../host/planner.js'

/** @typedef {import('../../host/types.js').SessionEvent} SessionEvent */
/** @typedef {import('../../host/types.js').State} State */
/** @typedef {import('../../host/types.js').Task} Task */
/** @typedef {import('../../host/types.js').EndVerdict} EndVerdict */

/**
 * @typedef {{ kind: 'begin', title?: string }
 *   | { kind: 'end', id?: string, verdict?: EndVerdict }
 *   | { kind: 'other', name?: string, error?: boolean }} CallSpec
 */

const SURFACE_TYPES = new Set(['system/message', 'user/message', 'assistant/message', 'tool/result'])

export class Sim {
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
    if (SURFACE_TYPES.has(event.type)) this.applySurface(event)
    this.state = apply(this.state, event)
    return event.seq
  }

  /** @param {SessionEvent} event */
  applySurface(event) {
    const op = event.surfaceOp
    if (op === 'append' || op === undefined) {
      this.nodes.push(event.seq)
      return
    }
    if (typeof op === 'object') {
      const i = this.nodes.indexOf(op.startSeq)
      const j = this.nodes.indexOf(op.endSeq)
      if (i === -1 || j === -1 || i > j)
        throw new Error(`sim: bad replace range ${op.startSeq}..${op.endSeq}`)
      this.nodes.splice(i, j - i + 1, event.seq)
    }
  }

  /** @param {string} [text] @param {object} [source] */
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
   */
  assistant(calls = []) {
    const ids = calls.map(() => `call_${this.callNo++}`)
    const content = [
      { type: 'text', text: 'thinking' },
      ...calls.map((c, i) => ({
        type: 'tool-call',
        id: ids[i],
        name: c.name,
        arguments: JSON.stringify(c.args || {}),
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
   * @param {{ meta?: unknown, isError?: boolean, name?: string }} [options]
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
        content: [{ type: 'text', text: 'result' }],
        isError: Boolean(options.isError),
      },
    }
    if (options.meta !== undefined) data.meta = options.meta
    return this.push({ type: 'tool/result', data, surfaceOp: 'append', sourceEventSeqs: [callSeq] })
  }

  /**
   * One batch: an assistant message with these calls, then each call executed in order,
   * the way the native executor does, with task-tool meta computed at execution time.
   *
   * @param {CallSpec[]} specs
   * @param {{ stepEnd?: boolean, drop?: number, repair?: boolean }} [options]
   *   drop: number of trailing results never delivered; repair: then close them with synthetic
   *   error results, as the host's session repair does (openTurnClosers in session/src/repair.ts)
   */
  batch(specs, options = {}) {
    const { seq, ids } = this.assistant(specs.map((s) => ({ name: callName(s) })))
    const deliver = specs.length - (options.drop || 0)
    for (let i = 0; i < deliver; i++) {
      const spec = /** @type {CallSpec} */ (specs[i])
      const id = /** @type {string} */ (ids[i])
      if (spec.kind === 'begin') this.result(id, { meta: this.beginMeta(spec), name: 'task_begin' })
      else if (spec.kind === 'end') {
        const meta = this.endMeta(spec, id)
        this.result(id, meta ? { meta, name: 'task_end' } : { isError: true, name: 'task_end' })
      } else this.result(id, { isError: Boolean(spec.error), name: spec.name || 'read' })
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

  /** @param {number} [n] */
  work(n = 1) {
    for (let i = 0; i < n; i++) this.batch([{ kind: 'other' }])
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
  say() {
    return this.assistant([])
  }

  /**
   * A host compaction transaction replacing the surface range start..end (inclusive, by seq).
   *
   * @param {number} startSeq
   * @param {number} endSeq
   */
  compact(startSeq, endSeq) {
    const i = this.nodes.indexOf(startSeq)
    const j = this.nodes.indexOf(endSeq)
    if (i === -1 || j === -1 || i > j) throw new Error(`sim: cannot compact ${startSeq}..${endSeq}`)
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
        content: [{ type: 'text', text: 'checkpoint' }],
        source: { kind: 'compact-checkpoint' },
      },
      surfaceOp: { op: 'replace', startSeq, endSeq },
      sourceEventSeqs: [startEv, summaryEv, ...shadowed],
    })
    this.push({ type: 'compaction/end', data: { compactionId } })
    return node
  }

  /**
   * Auto compaction of the oldest `count` nodes after the system message, snapped to a balanced end.
   *
   * @param {number} count
   */
  compactHead(count) {
    const candidates = this.nodes.slice(1)
    let end = Math.min(count, candidates.length) - 1
    while (end >= 0 && !this.balancedRange(1, end + 1)) end--
    if (end < 0) return null
    return this.compact(/** @type {number} */ (this.nodes[1]), /** @type {number} */ (this.nodes[end + 1]))
  }

  failCompaction() {
    const compactionId = `c${this.seq}`
    this.push({ type: 'compaction/start', data: { compactionId, turn: 1 } })
    return this.push({ type: 'compaction/end', data: { compactionId, error: { message: 'failed' } } })
  }

  /**
   * The tool-result pruner: replaces one result, keeping its data (including meta).
   *
   * @param {number} seq
   */
  prune(seq) {
    const original = this.bySeq.get(seq)
    if (!original || original.type !== 'tool/result') throw new Error(`sim: ${seq} is not a tool result`)
    this.push({
      type: 'compaction/prune',
      data: { shadowedSeqs: [seq], shadowedRange: { start: seq, end: seq }, shadowedTokenCount: 100 },
    })
    return this.push({
      type: 'tool/result',
      data: original.data,
      surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
      sourceEventSeqs: [seq],
    })
  }

  /**
   * Fold a task the way the fold runner will: resolve its region and compact it.
   *
   * @param {string} id
   */
  fold(id) {
    const task = this.state.tasks[id]
    if (!task) throw new Error(`sim: no task ${id}`)
    const region = resolveRegion(task, this.nodes)
    if (region.kind !== 'fold') throw new Error(`sim: ${id} has no foldable region (${region.kind})`)
    return this.compact(region.start, region.end)
  }

  /**
   * Reference tool-pairing check over surface positions [i, j] (inclusive): every call made
   * in the range is answered in it, and every result in it answers a call made in it.
   *
   * @param {number} i
   * @param {number} j
   */
  balancedRange(i, j) {
    const calls = new Set()
    const results = new Set()
    for (const seq of this.nodes.slice(i, j + 1)) {
      const ev = /** @type {SessionEvent} */ (this.bySeq.get(seq))
      if (ev.type === 'assistant/message') {
        for (const block of ev.data.message.content) if (block.type === 'tool-call') calls.add(block.id)
      } else if (ev.type === 'tool/result') {
        results.add(ev.data.message.toolCallId)
      }
    }
    if (calls.size !== results.size) return false
    for (const id of calls) if (!results.has(id)) return false
    return true
  }
}

/** @param {CallSpec} spec */
function callName(spec) {
  if (spec.kind === 'begin') return /** @type {string} */ (TASK_TOOLS[0])
  if (spec.kind === 'end') return /** @type {string} */ (TASK_TOOLS[1])
  return spec.name || 'read'
}
