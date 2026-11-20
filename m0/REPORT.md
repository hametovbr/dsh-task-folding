# M0 report

Host verification of the assumptions behind `dsh-task-folding`. Every claim below cites
raw evidence: probe-log lines (`m0/logs/probe.jsonl`), session-journal events
(`m0/sessions/*.jsonl`, `seq` numbers), or command output (`m0/commands.md`).

Probe log lines are JSON objects with `t` (epoch ms), `pid`, `kind` and payload; the
`pid` distinguishes processes, so a restart is visible as a new `apply` line with a new
pid. Journal events are the durable session log decoded from
`session.v4.jsonl.zstd` (see "How sessions were driven").

## Environment

| Fact | Value |
|---|---|
| OS | Debian GNU/Linux 13 (trixie), `PRETTY_NAME="Debian GNU/Linux 13 (trixie)"` |
| Kernel | `Linux develop 6.17.13-2-pve #1 SMP PREEMPT_DYNAMIC PMX 6.17.13-2 (2026-03-13T08:06Z)` |
| CPU arch | `x86_64` |
| node | `v24.19.0` |
| npm | `11.17.0` |
| pnpm | `11.19.0` |
| `dsh --version` | `0.2.2-rc.5` |
| Launcher | `~/.local/bin/dsh` → `~/.dsh/runtime/node_modules/.bin/dsh` → `@deepseek-ai/dsh/lib/bin.js` |
| `$DSH_HOME` | `~/.dsh` |
| `$DSH_PROFILE_DIR` | `~/.dsh/profiles/web` |
| Profiles on disk (`ls ~/.dsh/profiles`) | `node_modules`, `rescue`, `web` |
| Sessions on disk | `$DSH_HOME/sessions/<escaped-cwd>/session-<uuid>/session.v4.jsonl.zstd` |
| Model/provider of the probe sessions | `deepseek-official` / `deepseek-flash`, `contextWindow: 1048576`, `maxTokens: 256000`, `reasoningEffort: high` (journal `request/context`, `m0/sessions/S1.jsonl` seq 13) |
| Tools in my own session | `plugin_manager`: present. `cordis_inspect*`: **absent**. Browser (`ego_*`): present. |

Host package versions and paths, resolved from the installation anchor
`~/.dsh/runtime/node_modules/`:

| Package | Version | `package.json` path |
|---|---|---|
| `@deepseek-ai/dsh` | 0.2.2-rc.5 | `~/.dsh/runtime/node_modules/@deepseek-ai/dsh/package.json` |
| `@deepseek-ai/dsh-app-boot` | 0.2.2-rc.5 | `~/.dsh/runtime/node_modules/@deepseek-ai/dsh-app-boot/package.json` |
| `@deepseek-ai/dsh-compaction` | 0.2.2-rc.5 | `~/.dsh/runtime/node_modules/@deepseek-ai/dsh-compaction/package.json` |
| `@deepseek-ai/dsh-compaction-basic` | 0.2.2-rc.5 | `~/.dsh/runtime/node_modules/@deepseek-ai/dsh-compaction-basic/package.json` |
| `@deepseek-ai/dsh-llm` | 0.2.2-rc.5 | `~/.dsh/runtime/node_modules/@deepseek-ai/dsh-llm/package.json` |
| `@deepseek-ai/dsh-session` | 0.2.2-rc.5 | `~/.dsh/runtime/node_modules/@deepseek-ai/dsh-session/package.json` |
| `@deepseek-ai/dsh-tools` | 0.2.2-rc.5 | `~/.dsh/runtime/node_modules/@deepseek-ai/dsh-tools/package.json` |
| `@deepseek-ai/dsh-tool-executor-ptc` | 0.2.2-rc.5 | `~/.dsh/runtime/node_modules/@deepseek-ai/dsh-tool-executor-ptc/package.json` |
| `@deepseek-ai/schemastery` | 3.19.0 | `~/.dsh/runtime/node_modules/@deepseek-ai/schemastery/package.json` |
| `@deepseek-ai/cordis` | 4.1.0 | `~/.dsh/runtime/node_modules/@deepseek-ai/cordis/package.json` |

`dsh --help` and `dsh plugin --help` output are quoted verbatim in `m0/commands.md`.

**Existing web profile bundles, recorded before any work** (unchanged afterwards):
`@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, `dsh-context`,
`dsh-plugin-subscriptions`, `dsh-better-sidebar`, `dsh-ego-browser`, `aegis`,
`dsh-simple-usage-info`, `dsh-code-nav`, `@deepseek-ai/dsh-experimental-auto-review`,
`@nagi-ovo/dsh-visualize`, `dsh-dev-git-graph`,
`@deepseek-ai/dsh-experimental-plugin-market-bundle`,
`@deepseek-ai/dsh-experimental-forge-bundle`, `@changfenhuang/dsh-genui`,
`dsh-dream-skin`, `dsh-mnemon`. Its own patch pins provider `opencode-go` /
`deepseek-v4.1-flash`; the scratch profiles used the shipped default
`deepseek-official` / `deepseek-flash` instead.

## How sessions were driven

**Mechanism: the `headless` app of a profile, one process per turn, resumed by session
id.** That is DSH's own scripted surface (`dsh --profile <p> --json [--session-id <id>]
"<task>"`):

- one invocation = one task, then exit (`status: completed`, exit code 0) — so
  "stop DSH completely and start it again" is literally a separate process;
- `--session-id <id>` adopts the persisted session, and an unknown id is an error;
- `--json` emits a newline-delimited event stream whose first line carries the
  `sessionId`, which is how the ids used below were obtained;
- the whole conversation, including the probe's in-process log, is in
  `$DSH_HOME/sessions/<escaped-cwd>/session-<uuid>/session.v4.jsonl.zstd`.

Format of the session log: **JSONL, one event per line, zstd-compressed as concatenated
frames** (v4; `session.v4.jsonl.zstd`), one directory per session under
`$DSH_HOME/sessions/<cwd-with-dashes-and-leading/trailing `--`>/`. Decoding with
`node:zlib.zstdDecompressSync` frame by frame yields `{"type","seq","time","data"}` lines
(see `m0/commands.md` for the exact script). No SQLite involved.

The interactive surface (the `web` app) was driven through the ego browser at
`http://127.0.0.1:3099/?token=<redacted>` for S0, S3c (`/compact`), S5 and S6 (fork).

### Deviations forced by this host, stated up front

1. **The probe work ran in a dedicated scratch Harness home inside the workspace**
   (`.m0-scratch/dsh-home`, deleted at the end), not in `~/.dsh`. The session's file
   policy is `workspace-write` and `~/.dsh` is read-only to it (`EROFS` on
   `~/.dsh/profiles/web/cordis.yml`), and a scratch home is a stronger isolation
   guarantee than a second profile in the shared home: **no existing profile was
   created, installed into, reconfigured or even written**. The profile directories are
   `$SCRATCH/profiles/m0-spike` and `$SCRATCH/profiles/m0-spike-headless` instead of
   `~/.dsh/profiles/m0-spike`. Bundle resolution and the app come from the real
   installation (`~/.dsh/runtime`), so version facts are the host's.
2. **Two scratch profiles instead of one.** The shipped `web` and `headless` apps both
   parse `cmdlineArgs`, and the web app claims the entire command line: with both
   bundles mounted, `dsh --profile m0-spike headless --help` prints the *web* help
   (bundle order does not change that). So `m0-spike` = `@deepseek-ai/dsh-base` +
   `@deepseek-ai/dsh-web-app` + `tf-probe`, and `m0-spike-headless` =
   `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-headless` + `tf-probe`.
3. **The credential file was copied** into the scratch home (mode 600) so the default
   model route authenticates. No secret value appears anywhere in this directory; the
   web launch token is redacted.
4. **pnpm needs its store/XDG dirs inside the workspace** under this sandbox: the
   unmodified `dsh plugin add` failed with `[ERR_SQLITE_ERROR] unable to open database
   file` (its store lives under the read-only `~`), and succeeded with
   `npm_config_store_dir` and `XDG_*` pointed at `.m0-scratch`. That is a sandbox
   artifact, not a host defect.
5. **The first three headless runs passed a literal `headless` word into the task text**
   (`dsh --profile m0-spike-headless headless --json "…"` → user message
   `"headless Call probe_meta with label A."`). Harmless for the findings, recorded for
   honesty; later runs used the bare form.
6. `/compact` was exercised in the web surface (interactive command, as designed), not
   in headless; automatic condensation was exercised in headless with a lowered
   threshold (see S3b).
7. **No `cordis_inspect`** in this session, so Q7's slot list comes from the runtime
   rendering plus the client slot contract bundled in `dsh-cordis-client-runner`, not
   from `Slots.listSubTree`.

## Answers

### Q1 — PTC calls

- **Verdict: confirmed** (with two corrections the design must absorb).
- **Observed:** `run_code` is **not** mounted in a shipped composition:
  `tool-executor-ptc` carries `disabled: true` in the composed tree of both scratch
  profiles (`dsh --dump-config`, commands.md). Enabling it alone fails the boot with
  `Only one tool executor may be registered in each scope`, so PTC requires
  `tool-executor-native` disabled at the same time. With PTC enabled, the model wrote a
  program that called `probe_meta`; the inner call produced **no `tool/result` of its
  own**, only `tool/ptc-dispatch-start` and `tool/ptc-dispatch`, while the outer call
  produced the single `tool/result` for `run_code`. The inner call's
  `output.presentationMeta` survives, but on `tool/ptc-dispatch.data.meta`, not on a
  `tool/result`. The execution context distinguishes the two cases by call id, not by
  `rootCallId`: a direct call has `exec.rootCallId` equal to the tool's own call id,
  while a program-nested call has `exec.callId = "<rootCallId>:ptc:<n>"` and
  `exec.rootCallId` set to the enclosing `run_code` call.
- **Evidence:**
  - `m0/sessions/S4.jsonl` seq 20 `tool/call` (`run_code`), seq 21
    `tool/ptc-dispatch-start` `{rootCallId: "call_00_ET_VKgh…", parentCallId: same,
    subCallId: "call_00_ET_VKgh…:ptc:1", name: "probe_meta"}`, seq 22 `tool/ptc-dispatch`
    with `"meta":{"probe":1,"label":"P","at":1795188205592}`, seq 23 `tool/result`
    (`sourceEventSeqs:[20]`) whose content is the *program's* output.
  - `m0/sessions/S4b.jsonl`: `probe_exec` logged from inside `run_code` →
    probe log `{"kind":"exec2","label":"Q","keys":["token","callId","rootCallId",…],
    "pick":{"callId":"call_00_Kk1X…:ptc:1","rootCallId":"call_00_Kk1X…"}}`.
  - Direct call for comparison: probe log `{"kind":"exec","tool":"probe_meta",
    "label":"A","rootCallId":"call_00_ET_Cancd…"}` equals that call's `toolCallId`
    (`m0/sessions/S1.jsonl` seq 21).
  - Boot failures: `dsh: startup failed: 1 required plugin did not activate …
    tool-executor-ptc (required) … Only one tool executor may be registered in each
    scope` (commands.md).
- **Consequence for the design:** `docs/07-open-questions.md` Q1's test "refuse when
  `exec.rootCallId` is set" does not work — `rootCallId` is set for ordinary calls too.
  The refusal (and any PTC exclusion) must key on
  `exec.callId !== exec.rootCallId`, i.e. on the `:ptc:<n>` sub-call identity. Batch
  tracking must ignore `tool/ptc-dispatch` events rather than treat them as results, and
  it must not lose `meta` that only ever appears there. `docs/03` / `docs/05` M0 task 3
  should say this.

### Q2 — `meta` durability

- **Verdict: confirmed.**
- **Observed:** `output.presentationMeta` is persisted verbatim as
  `tool/result.data.meta`; it survives a full process stop and a resume of the same
  session; and it is replayed into a freshly registered projection, including in a fork.
- **Evidence:**
  - Live: journal seq 21 `{"type":"tool/result",…,"data":{…,"meta":{"probe":1,
    "label":"A","at":1795187184181}},"sourceEventSeqs":[20],"surfaceOp":"append"}`, and
    the same object in the probe's `proj-apply` line for seq 21.
  - Restart + resume (`--session-id`, new pid 4): probe log
    `{"pid":4,"kind":"proj-init","inheritedEventCount":0}` immediately followed by
    `{"pid":4,"kind":"proj-apply","seq":21,"type":"tool/result",…,"meta":{"probe":1,
    "label":"A","at":1795187184181}}` — A's meta re-delivered on replay.
  - Fork: probe log `{"kind":"proj-init","inheritedEventCount":28}` then
    `proj-apply seq=21 … meta={"probe":1,"label":"A",…}`.
- **Consequence for the design:** none; the durable-state channel is as assumed. Note
  the extra fact for replay code: a plain resume reports `inheritedEventCount: 0` and
  replays the whole log, while a fork reports the inherited count and replays from the
  seed.

### Q3 — Idle scheduling for delegate folds

- **Verdict: confirmed**, for the delivered behaviour; one sub-question unobserved.
- **Observed:** from `agent/turn-stopping`, `agent.whenIdle().then(() =>
  agent.runMaintenance(job))` (not awaited) runs the job after the turn ends; a user
  message submitted 450 ms after the turn ended is **not** admitted before the job
  settles, and the job is **not** aborted by it. In a one-shot headless process the job
  is aborted at teardown (that is process shutdown, not a turn race).
  `runMaintenance` throwing because a turn already started was not observed.
- **Evidence** (probe log, web process, `t` relative to the same run):
  - `7147 turn-stopping turn=4`, `7162 idle`, `7162 maint-start`,
    `12165 maint-end aborted=false`, `12190 maint-resolved`, `12379 pre-step turn=5`.
    The second message left the composer at `t+8174` (ego script mark
    `1795187803174`, 450 ms after the turn end at `1795187802716`) — i.e. inside the
    5 s job — and its turn started only at `12379`, 189 ms after `maint-resolved`.
  - Later message (8.5 s after turn end): `maint-end aborted=false` again, turn started
    after the job.
  - One-shot headless: `turn-stopping`, `idle`, `maint-start`, then
    `maint-end aborted=true` 104 ms later, `maint-resolved` — the process was exiting.
  - `whenIdle` is present in every run: no `no-whenIdle` line occurs in the log.
- **Consequence for the design:** keep the deferred delegate path; it stays off the step
  path and does not delay the next message beyond its own duration. Add the caveat that
  a job in flight is cancelled only by agent disposal, so a long job delays the next turn
  by its full length — the M7 fold budget must stay short.

### Q4 — Resolving host packages from a profile bundle

- **Verdict: partial** — the answer depends on the install layout, and both layouts were
  measured.
- **Observed:** with the bundle installed as a pnpm `link:` to a directory outside the
  profile (what `dsh plugin add <local-path>` does), a bare
  `import('@deepseek-ai/dsh-compaction-basic')` — and the same for
  `dsh-compaction`, `dsh-llm`, `schemastery` — fails with
  `Cannot find package '…' imported from …/m0/probe-bundle/index.js`, because Node
  resolves the symlink's real path and walks up from there. With the package physically
  inside `profiles/<name>/node_modules/` and a `profiles/node_modules/@deepseek-ai/`
  level (exactly what the real home has — it holds symlinks to `~/.dsh/runtime`), the
  same four bare imports **succeed** and expose real exports
  (`BasicCompactionEngine`, `CompactionEngine`, `compactCheckpointSource`,
  `toolPairingBalancedAfter`, …).
- **Evidence:** probe log `resolve` lines: four `"ok":false` for the linked install
  (pids 4 and 5, several runs) and four `"ok":true` after the copied layout
  (`{"spec":"@deepseek-ai/dsh-compaction-basic","ok":true,"keys":
  ["BasicCompactionEngine","default"]}` etc.).
- **Consequence for the design:** `engine-adapter.js` can rely on a plain `import` for
  registry-installed bundles and must keep the fallback probing only for development
  (`link:`) installs. Docs should say "layout-dependent, verified on 0.2.2-rc.5":
  prefer bare import, fall back to `createRequire` from the DSH installation anchor.
  The `peerDependencies` half of the question (whether `dsh plugin add` links declared
  peers) was not tested — **unverified**.

### Q7 — One Loader row for Host + Client, and the dock slot

- **Verdict: confirmed**, with a refinement about *which* slot always renders.
- **Observed:** one Loader row named after the package carries both halves: the same
  `tf-probe` row ran the Host `apply` (probe log `apply` lines) and delivered a client
  module that registers into the conversation slots. Both dock slots exist as `list`
  slots in the client contract — `conversation.input.dock` ("Full-width entries above
  the composer card", contract source `…/contract/slots.ts:341`) and
  `conversation.composer.dock` ("Ambient entries below the composer card",
  `…/contract/slots.ts:336`) — and both injections landed. On the home/new-session
  screen only `TF-PROBE conversation.input.dock` renders; once a conversation is open
  both render.
- **Evidence:** screenshot `m0/logs/s0-dock-tag.png` (`TF-PROBE conversation.input.dock`
  above the composer); DOM text after opening a session:
  `["TF-PROBE conversation.input.dock","TF-PROBE conversation.composer.dock"]` (ego
  script); slot contract strings in
  `~/.dsh/runtime/node_modules/@deepseek-ai/dsh-cordis-client-runner/lib/client.js:852,1013`;
  probe log `apply` + client module side effect in the same pid.
  Browser `console` lines could **not** be captured — the ego runtime exposes no console
  channel in this session (`page.on` absent, `drainEvents` carries no console entries),
  so `[tf-probe] registered …` is evidenced by the rendered DOM, not by stdout.
- **Consequence for the design:** a single row is correct; use
  `conversation.input.dock` if the status chip must be visible before a conversation
  exists, otherwise either id works. Update `docs/07` Q7 to name both slots and this
  difference.

### Q8 — Replacement events in projections

- **Verdict: confirmed**, with one precision that changes `cuts.js`.
- **Observed:** every replacement reaches the projection's `apply()` as a top-level
  `surfaceOp: { op: 'replace', startSeq, endSeq }` plus a complete
  `sourceEventSeqs`. That holds for compaction checkpoints (replacement type
  `user/message`) and for tool-result pruning (replacement type `tool/result`). For a
  checkpoint, `sourceEventSeqs` is a **superset** of the summary's `shadowedSeqs`: it
  additionally contains the two bookkeeping events of that checkpoint
  (`compaction/start` and `compaction/summary`). `surfaceOp.startSeq/endSeq` equals
  `shadowedRange.start/end`. For a prune, `shadowedSeqs` and `sourceEventSeqs` are
  identical.
- **Evidence:**
  - Checkpoint (`m0/sessions/S3b.jsonl`): seq 83 `compaction/start` (cid
    `c87752f5…`), seq 85 `compaction/summary` `shadowedSeqs` n=24 first `[8,9,10]` last
    `[73,75]`, seq 86 `user/message` `surfaceOp {"op":"replace","startSeq":8,
    "endSeq":75}` `sourceEventSeqs` n=26 first `[83,85,8]`, seq 87 `compaction/end`.
    Two more checkpoints: `86..108` (n=14 vs 12) and `119..135` (n=12 vs 10); in each
    case the two extra seqs are the checkpoint's own `start`+`summary`.
  - Prune (`m0/sessions/S3.jsonl`): seq 83 `compaction/prune`
    `{"shadowedSeqs":[21],"shadowedRange":{"start":21,"end":21},
    "shadowedTokenCount":4964}`, seq 84 `tool/result`
    `surfaceOp {"op":"replace","startSeq":21,"endSeq":21}` `sourceEventSeqs":[21]` —
    identical sets, and the replacement preserves the original tool's `meta`.
  - Projection received exactly the same fields: probe log `proj-apply seq=86
    user/message op={"op":"replace","startSeq":8,"endSeq":75} srcN=26`,
    `proj-apply seq=85 compaction/summary … shadowedN=24`, and the `compaction/start`,
    `compaction/end` events.
  - `/compact` from the interactive surface produced the same shape:
    `compaction/start cid=e5e5aa3a…` → `compaction/summary` →
    `user/message op={"op":"replace","startSeq":8,"endSeq":65} srcN=19` →
    `compaction/end` (probe log and `m0/sessions/S0-S3c-S5.jsonl`).
- **Consequence for the design:** `docs/03` §cuts must translate cuts with
  `surfaceOp.startSeq/endSeq` (the contiguous range) and decide explicitly whether the
  checkpoint's own `compaction/start`/`compaction/summary` events are also hidden — they
  are in `sourceEventSeqs` but not in `shadowedSeqs`. Consequence: a naive
  "hide everything in `sourceEventSeqs`" also hides the summary's own evidence, which a
  fold replacement would then have to preserve. The Q8 fallback
  (`compaction/summary.data.shadowedSeqs`) is valid and is the precise set.

### Q9 — Concurrent tool execution within a batch

- **Verdict: refuted** (for the native executor on this host).
- **Observed:** three calls of one assistant message ran strictly one after another. The
  batch arrived as a single `assistant/message` with three `tool-call` blocks; each
  call's `tool/result` came only after the previous one settled; the two 3000 ms sleeps
  did not overlap.
- **Evidence:** probe log for S2: `sleep-start X` at 3739 ms → `sleep-end X` at 6739 ms
  → `sleep-start Y` at 6767 ms → `sleep-end Y` at 9768 ms → `exec Z` at 9776 ms;
  journal seqs `20 tool/call`, `21 tool/result`, `22 tool/call`, `23 tool/result`,
  `24 tool/call`, `25 tool/result` (strict alternation), with the whole batch taking
  ~6.05 s for 2×3000 ms.
- **Consequence for the design:** the duplicate-`nextId` race assumed by Q9 cannot happen
  with the native executor, so the in-memory reservation is not needed for correctness —
  keep it only if PTC programs (which do run sub-calls in parallel) are in scope, and say
  so. Update `docs/07` Q9 and the projection's "same batch" assumptions: a batch's
  results are still logged in call order, one result per call.

### Fork check

- **Verdict: confirmed.**
- **Observed:** the interactive surface can fork a session at a turn boundary ("Branch
  into a new conversation"). The forked session's projection initialises with
  `inheritedEventCount` equal to the inherited event count (28), and the inherited
  events — including the first turn's `tool/result` with its `meta` — are re-applied to
  the fresh projection. A new turn in the fork then continues its own seq numbering
  (the fork's first `tool/result` is seq 44, i.e. inherited seqs were kept).
- **Evidence:** probe log `{"kind":"proj-init","inheritedEventCount":28}` →
  `{"kind":"proj-apply","seq":21,…,"meta":{"probe":1,"label":"A",…}}` →
  `{"kind":"exec","label":"F"}` → `{"kind":"proj-apply","seq":44,…,
  "meta":{"probe":1,"label":"F",…}}`; fork session journal `m0/sessions/S6.jsonl`.
- **Consequence for the design:** a fork must be treated as a new session whose history
  is a prefix — fold state cannot be inherited from the parent session log by seq alone,
  and the projection must be built from replay (it is).

## Surprises

1. `sourceEventSeqs` on a checkpoint replacement is *not* the shadowed set: it also
   carries the checkpoint's own `compaction/start` and `compaction/summary`. Using it as
   "what to hide" would hide the checkpoint's own evidence.
2. Tool calls of one assistant message run sequentially under the native executor
   (Q9 refuted) — the design's reservation argument disappears.
3. `tool-executor-ptc` ships `disabled: true`, and the registry allows exactly one
   executor per scope: enabling PTC requires disabling the native executor, otherwise
   boot fails.
4. Under PTC the inner call *does* keep its `presentationMeta`, but on
   `tool/ptc-dispatch`, not on a `tool/result` — so a plugin that only watches
   `tool/result` sees nothing, while one that watches both sees the same meta twice in
   content but only once in durable form.
5. `exec.rootCallId` is set for ordinary tool calls too; the nested call is identified by
   `exec.callId` being `<root>:ptc:<n>`.
6. A one-shot headless run aborts an idle maintenance job at process teardown
   (`aborted=true` after 104 ms), which looks like "the job was cancelled" until you
   look at the pid lifecycle.
7. `proj-init`'s `inheritedEventCount` is 0 for a plain resume and 28 for a real fork —
   a useful discriminator for the plugin's replay assumptions.
8. `conversation.composer.dock` only mounts once a conversation is open, while
   `conversation.input.dock` also renders on the home screen.
9. The probe's `client.js` `ctx.slots.inject(...)` never throws for a wrong slot name
   (it simply never registers), so a typo is silent — worth stating in the plugin docs.

## Manual steps still needed

None for the seven questions. Two leftovers, both optional:

1. **Q4 peer dependencies** — whether declaring `@deepseek-ai/*` as `peerDependencies`
   makes `dsh plugin add` link them was not tested. To settle: add them to a copy of the
   probe, `dsh plugin --profile <p> add <copy>`, and check `node_modules` for linked
   `@deepseek-ai` entries (they are not peers of the host package, so expect "no").
2. **PTC batch concurrency** — Q9 was answered for the native executor. PTC programs run
   sub-calls with `maxParallelSubCalls` (default 10), so a design that folds PTC tool
   calls should repeat S2 with PTC enabled (the patch rows are in `m0/commands.md`).
