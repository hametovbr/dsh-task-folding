# M0 host verification — instructions for the on-host agent

You are running inside DeepSeek Harness (DSH) on a machine with DSH installed. Your job is milestone **M0** of the `dsh-task-folding` project: verify, on this real host, the assumptions the plugin design depends on, and deliver evidence in a fixed format. You write **no plugin code** beyond the throwaway probe described below.

Context, if you can read it: `docs/03-architecture.md`, `docs/05-implementation-plan.md` (M0 section) and `docs/07-open-questions.md` in https://github.com/hametovbr/dsh-task-folding. Everything you need is also in this file.

## 0. Rules

1. **Do not touch existing profiles.** Do all work in a new, dedicated profile named `m0-spike`. Never install, remove or reconfigure anything in any other profile, and never edit their `package.json` or `cordis.patch.yml`.
2. **Do not install `dsh-taskfold`** or any other third-party plugin.
3. **Evidence over conclusions.** Every answer must cite raw evidence: probe-log lines, session-log events (with `seq`), command output. If you could not observe something, mark it `unverified` and say why. Never guess.
4. **Stop and report** instead of improvising if a step needs something you do not have (a GUI, credentials, a missing command). Write what is missing into the report and continue with the remaining steps.
5. **Scrub secrets** from everything you deliver: API keys, tokens, `Authorization` headers, e-mail addresses. Replace the home directory path with `~`.
6. **English only** in every file you write.
7. Keep each step's commands and outputs; you will need them for the report.

## 1. Collect the environment

Record, verbatim:

- OS and version (`uname -a` or equivalent), CPU architecture.
- `node --version`, `npm --version`, `pnpm --version` (if present).
- `dsh --version` (or how DSH is launched here: Desktop app, `npx @deepseek-ai/dsh web`, global install).
- `dsh --help` and `dsh plugin --help` output.
- The list of existing profiles (names only) and where profiles live on disk (`$DSH_HOME`, `$DSH_PROFILE_DIR` if set).
- Versions of these installed packages, as resolved by the host: `@deepseek-ai/dsh`, `@deepseek-ai/dsh-app-boot`, `@deepseek-ai/dsh-compaction`, `@deepseek-ai/dsh-compaction-basic`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-tool-executor-ptc`, `@deepseek-ai/schemastery`, `@deepseek-ai/cordis`. Find them by locating their `package.json` files under the DSH installation (report the paths too).
- Which model/provider the `m0-spike` sessions will use.
- Whether you have these tools in your own session: `cordis_inspect`, `plugin_manager`, a browser/screenshot tool.

## 2. Find out how to drive a session non-interactively

The probes need scripted sessions in the `m0-spike` profile: send a user message, let the model run, send another, restart, resume, run `/compact`. Determine and record the exact mechanism available here, in order of preference:

1. a DSH CLI command that runs a prompt in a profile and exits, or a session/resume flag;
2. the ACP or API interface of a running DSH instance;
3. the Web GUI (only if you can operate a browser).

If none works, write the manual checklist for a human (exact messages to type, in order) into the report under "Manual steps", run what you can, and continue.

Also find where session logs are stored on disk for a profile and their format (JSONL per session? SQLite?). Record the path pattern.

## 3. Build the probe bundle

Create the directory `m0/probe-bundle/` with exactly these four files.

`package.json`:

```json
{
  "name": "tf-probe",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js", "./client": "./client.js" },
  "files": ["index.js", "client.js", "cordis.patch.yml"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "immediately": true, "inject": ["@deepseek-ai/dsh-client-ui-conversation"] }
  }
}
```

`cordis.patch.yml`:

```yaml
- insert:
    - id: tf-probe
      name: 'tf-probe'
```

`index.js`:

```js
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
```

`client.js` (Q7 — which dock slot exists, and whether one row serves both halves):

```js
window.__ModuleLoader__.load({
  id: 'tf-probe',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const tag = (slot) => function ProbeTag() {
      return h('div', { style: { fontSize: 11, opacity: 0.7, padding: '2px 6px' } }, 'TF-PROBE ' + slot)
    }
    return {
      inject: ['slots'],
      apply(ctx) {
        for (const slot of ['conversation.composer.dock', 'conversation.input.dock']) {
          try {
            ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, id: 'tf-probe-' + slot, order: 99 }, tag(slot)))
            console.log('[tf-probe] registered', slot)
          } catch (err) {
            console.log('[tf-probe] failed', slot, String(err && err.message ? err.message : err))
          }
        }
      },
    }
  },
})
```

Set `TF_PROBE_LOG` to an absolute path you control (for example `m0/logs/probe.jsonl` resolved to an absolute path) in the environment of the DSH process that runs the `m0-spike` profile. If you cannot set it, the log goes to `$(node -p "require('os').tmpdir()")/tf-probe.jsonl`; record which path was used.

Install the probe into the `m0-spike` profile only, for example `dsh plugin --profile m0-spike add /absolute/path/to/m0/probe-bundle`, then restart that profile's DSH process. Record the exact commands, their output, and the profile's resulting composed config (`dsh --profile m0-spike --dump-config` if available). If the client half breaks loading, remove `client.js` and the `dsh.client` / `./client` entries, reinstall, and record that as the Q7 result.

## 4. Scenarios

Run each scenario in a **new** session of the `m0-spike` profile unless stated otherwise. Before each scenario, write a marker line into the probe log yourself (`{"kind":"scenario","name":"S1"}`) so the log can be split later. After each scenario, copy that session's log file to `m0/sessions/<scenario>.jsonl`.

| ID | Questions | Steps (messages to the model in the probe session) | What to capture |
|---|---|---|---|
| S0 | Q4, Q7 | Start the profile; open one session; say "hello". | `apply` and `resolve` lines; `proj-ready`/`proj-error`; whether `TF-PROBE …` tags render (screenshot if possible) and browser console lines; `cordis_inspect` slot listing for names containing `dock` if you have the tool. |
| S1 | Q2 | "Call probe_meta with label A." Then stop DSH completely, start it again, resume the same session, and say "Call probe_meta with label B." | The `tool/result` events for A and B in the session log file (is `data.meta` present and equal to `{probe:1,label,at}`?); `proj-apply` lines before and after restart (does replay deliver A's `meta` again?). |
| S2 | Q9, batch shape | "In ONE message, call probe_sleep with label X and ms 3000, probe_sleep with label Y and ms 3000, and probe_meta with label Z." | Whether all three calls are in one `assistant/message`; order and timestamps of `sleep-start`/`sleep-end` (overlapping = concurrent); order of the three `tool/result` events and their seqs. |
| S3 | Q8 | Make the session long enough to compact: ask the model to read several large files of the DSH installation and summarize them (≥ 20 tool calls), then run `/compact`. Then ask for one more small read. | All `compaction/*` events; the replacement event (type, `surfaceOp`, full `sourceEventSeqs`); whether `proj-apply` received the replacement with the same fields; `shadowedSeqs` vs `sourceEventSeqs` (identical? subset?). If a tool-result pruner is active, capture one prune replacement too. |
| S4 | Q1 | Only if `run_code` exists in this profile: "Using run_code, write a program that calls probe_meta with label P." | The `exec` line (`rootCallId` set?); which events the log contains for the inner call (`tool/ptc-dispatch`? a `tool/result`?); where `meta` ends up. If `run_code` is absent, record how PTC is enabled in this host and whether you could enable it in `m0-spike` only. |
| S5 | Q3 | "Say OK and nothing else." As soon as that turn ends, within 2 seconds, send "Call probe_meta with label M." | Timestamps of `turn-stopping`, `idle`, `maint-start`, `maint-end`, `maint-resolved`/`maint-rejected`/`maint-throw`, and the `pre-step` of the second turn: did the second turn wait for the 5-second job, was the job aborted, did `runMaintenance` throw? Repeat once sending the second message 7+ seconds later. |
| S6 | fork | If the host supports forking a session: fork the S1 session after its first turn and say "Call probe_meta with label F." | `proj-init` with `inheritedEventCount` for the fork; whether the inherited A result is re-applied. |

## 5. Deliverables

Create these files (and nothing else outside `m0/`):

```
m0/
  REPORT.md            the human-readable report (template below)
  report.json          the machine-readable summary (schema below)
  probe-bundle/        the four probe files exactly as installed
  logs/probe.jsonl     the full probe log, scrubbed
  sessions/S*.jsonl    one session log per scenario, scrubbed
  commands.md          every command you ran with its output, in order, scrubbed
```

### `REPORT.md` template

```markdown
# M0 report

## Environment
(the facts from section 1, as a table)

## How sessions were driven
(the mechanism from section 2; limitations)

## Answers

### Q1 — PTC calls
- Verdict: confirmed | refuted | partial | unverified
- Observed: (one paragraph of plain facts)
- Evidence: (log lines / event seqs / file:line references, quoted)
- Consequence for the design: (what in docs/ must change, or "none")

### Q2 — meta durability
…same structure for Q2, Q3, Q4, Q7, Q8, Q9 and the fork check…

## Surprises
(anything unexpected, even if no question asked about it)

## Manual steps still needed
(exact steps for a human, if any scenario could not be run)
```

### `report.json` schema

```json
{
  "host": { "dsh": "", "dshAppBoot": "", "compactionBasic": "", "node": "", "os": "" },
  "drive": { "mechanism": "", "limitations": "" },
  "questions": {
    "Q1": { "verdict": "confirmed|refuted|partial|unverified", "summary": "", "evidence": ["…"] },
    "Q2": {}, "Q3": {}, "Q4": {}, "Q7": {}, "Q8": {}, "Q9": {}, "fork": {}
  },
  "facts": {
    "metaPersistedOnToolResult": null,
    "metaReplayedToProjection": null,
    "replaceEventHasSurfaceOp": null,
    "sourceEventSeqsEqualsShadowedSeqs": null,
    "ptcInnerCallHasOwnToolResult": null,
    "batchCallsRunConcurrently": null,
    "turnStoppingMaintenanceRunsAfterTurn": null,
    "maintenanceBlocksNextTurnUntilDone": null,
    "runMaintenanceThrowsWhenBusy": null,
    "bareImportResolves": { "@deepseek-ai/dsh-compaction-basic": null, "@deepseek-ai/dsh-compaction": null, "@deepseek-ai/dsh-llm": null, "@deepseek-ai/schemastery": null },
    "dockSlotName": null,
    "singleRowHostAndClientWorks": null,
    "forkInheritedEventCountObserved": null
  }
}
```

Use `true`/`false` for observed facts and leave `null` only for what you could not observe (then explain in `REPORT.md`).

## 6. Finish

- Uninstall the probe from `m0-spike` (or delete the whole `m0-spike` profile) and confirm no other profile changed: compare the list of profiles and their installed bundles with what you recorded in section 1.
- If this machine has a clone of `hametovbr/dsh-task-folding` with push rights, commit only the `m0/` directory to `main` with the subject `Add M0 host verification results` and push. Otherwise pack `m0/` into `m0-results.tar.gz` and print its absolute path.
- End with a five-line summary: host version, how many questions were confirmed / refuted / partial / unverified, and the single most important surprise.
