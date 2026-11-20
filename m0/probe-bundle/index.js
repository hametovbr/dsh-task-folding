import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const LOG = process.env.TF_PROBE_LOG || path.join(os.tmpdir(), 'tf-probe.jsonl')

function log(kind, data = {}) {
  try { fs.appendFileSync(LOG, JSON.stringify({ t: Date.now(), pid: process.pid, kind, ...data }) + '\n') } catch {}
}

function errText(err) { return String(err && err.message ? err.message : err) }

function brief(e) {
  const msg = e && e.data && e.data.message
  const content = msg && Array.isArray(msg.content) ? msg.content : []
  return {
    seq: e.seq,
    type: e.type,
    surfaceOp: e.surfaceOp,
    sourceEventSeqs: e.sourceEventSeqs,
    toolCallId: msg && msg.toolCallId,
    isError: msg && msg.isError,
    source: msg && msg.source,
    calls: content.filter((b) => b && b.type === 'tool-call').map((b) => ({ id: b.id, name: b.name })),
    meta: e.data && e.data.meta,
    compactionId: e.data && e.data.compactionId,
    shadowedSeqs: e.data && e.data.shadowedSeqs,
    shadowedRange: e.data && e.data.shadowedRange,
    error: e.data && e.data.error,
  }
}

const sleep = (ms, signal) => new Promise((resolve) => {
  const id = setTimeout(resolve, ms)
  if (signal) signal.addEventListener('abort', () => { clearTimeout(id); resolve() }, { once: true })
})

export default {
  name: 'tf-probe',
  inject: ['tools', 'sessionProjections'],
  apply(ctx) {
    log('apply', { node: process.versions.node, argv1: process.argv[1], cwd: process.cwd() })

    // Q4: which host packages resolve with a bare import from a profile-installed bundle
    void (async () => {
      for (const spec of [
        '@deepseek-ai/dsh-compaction-basic', '@deepseek-ai/dsh-compaction',
        '@deepseek-ai/dsh-llm', '@deepseek-ai/schemastery',
      ]) {
        try {
          const m = await import(spec)
          log('resolve', { spec, ok: true, keys: Object.keys(m).slice(0, 40) })
        } catch (err) {
          log('resolve', { spec, ok: false, error: errText(err) })
        }
      }
    })()

    // Raw committed events, as the session emits them
    ctx.on('session/event', (session, event) => {
      log('event', { session: session && session.id, ...brief(event) })
    })

    // Q2/Q8: what a projection's apply() receives, live and on replay
    const handle = ctx.sessionProjections.register({
      key: 'tfProbe',
      stateSchema: { parse: (v) => v },
      init: (header, inheritedEventCount) => {
        log('proj-init', { inheritedEventCount: Number(inheritedEventCount) })
        return { n: 0 }
      },
      apply: (state, event) => {
        const interesting = event.type === 'tool/result' || event.type.startsWith('compaction/')
          || (event.surfaceOp && event.surfaceOp.op === 'replace')
        if (interesting) log('proj-apply', brief(event))
        return state
      },
      stateVersion: 1,
    })
    Promise.resolve(handle).then(() => log('proj-ready'), (err) => log('proj-error', { error: errText(err) }))

    // Q2, Q1: meta persistence and PTC visibility
    ctx.tools.register({
      name: 'probe_meta',
      description: 'Diagnostic probe. Returns a label. Call it exactly when the user asks you to.',
      parameters: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (args, v) => [{ type: 'text', text: 'probe ok: ' + v.label }],
        presentationMeta: (args, v) => ({ probe: 1, label: v.label, at: v.at }),
      },
      async execute(args, exec) {
        const label = args && typeof args.label === 'string' ? args.label : '?'
        log('exec', {
          tool: 'probe_meta', label,
          rootCallId: exec && exec.rootCallId,
          hasAgent: Boolean(exec && exec.agent),
          sessionId: exec && exec.agent && exec.agent.session && exec.agent.session.id,
        })
        return { label, at: Date.now() }
      },
    })

    // Q9: are calls of one assistant message executed concurrently?
    ctx.tools.register({
      name: 'probe_sleep',
      description: 'Diagnostic probe. Waits ms milliseconds. Call it exactly when the user asks you to.',
      parameters: {
        type: 'object',
        properties: { label: { type: 'string' }, ms: { type: 'integer' } },
        required: ['label', 'ms'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (args, v) => [{ type: 'text', text: 'slept: ' + v.label }],
      },
      async execute(args, exec) {
        const ms = Math.min(Math.max(Number(args.ms) || 0, 0), 10000)
        log('sleep-start', { label: args.label, ms })
        await sleep(ms, exec && exec.signal)
        log('sleep-end', { label: args.label })
        return { label: args.label }
      },
    })

    ctx.on('agent/pre-step', async (payload, next) => {
      log('pre-step', { turn: payload.turn, step: payload.step })
      return next()
    })

    // Q3: idle maintenance scheduled from turn-stopping
    ctx.on('agent/turn-stopping', (payload) => {
      const agent = payload.agent
      log('turn-stopping', { turn: payload.turn })
      if (!agent || typeof agent.whenIdle !== 'function') { log('no-whenIdle'); return }
      agent.whenIdle().then(() => {
        log('idle')
        try {
          agent.runMaintenance(async (signal) => {
            log('maint-start')
            await sleep(5000, signal)
            log('maint-end', { aborted: Boolean(signal && signal.aborted) })
          }).then(() => log('maint-resolved'), (err) => log('maint-rejected', { error: errText(err) }))
        } catch (err) {
          log('maint-throw', { error: errText(err) })
        }
      })
    })
  },
}
