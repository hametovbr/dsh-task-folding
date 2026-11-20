// Probe for the M3 construction spike: after the fold engine exists, ask the realm's own
// ctx.compaction service to compact one balanced range. If the realm engine still works, the
// journal shows a compaction/summary with llmStreamCall: true; our own folds never set it.

import { loadHostModule } from '../../host/resolve.js'

const log = (/** @type {string} */ message) => process.stderr.write(`[m3-realm-probe] ${message}\n`)

export default {
  name: 'm3-realm-probe',
  apply(ctx) {
    let done = false
    ctx.on('agent/turn-stopping', async (payload) => {
      const agent = payload && payload.agent
      if (done || !agent) return
      done = true
      const engine = ctx.get('compaction')
      if (engine === undefined || typeof engine.compactRegion !== 'function')
        return log(`the realm compaction service is not available: ${String(engine)}`)
      log(`realm engine is ${engine.constructor?.name ?? 'unknown'}`)
      const publicApi = await loadHostModule('@deepseek-ai/dsh-compaction')
      const session = agent.session
      const nodes = session.surface.nodes
      if (!publicApi || nodes.length < 3) return log('nothing to compact')
      const start = nodes[1]
      for (let endIndex = nodes.length - 2; endIndex > 0; endIndex--) {
        const end = nodes[endIndex]
        try {
          if (!publicApi.toolPairingBalancedAfter(session, end)) continue
        } catch (error) {
          return log(`balance check failed: ${messageOf(error)}`)
        }
        try {
          const result = await engine.compactRegion(start, end, agent, payload.signal)
          return log(`realm compactRegion committed: shadowed ${result?.shadowedSeqs?.length ?? '?'} nodes`)
        } catch (error) {
          log(`realm compactRegion refused ${start}..${end}: ${messageOf(error)}`)
        }
      }
      log('no balanced range found')
    })
  },
}

const messageOf = (/** @type {unknown} */ error) => (error instanceof Error ? error.message : String(error))
