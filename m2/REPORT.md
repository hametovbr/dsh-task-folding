# M2 — Tools without folding: live acceptance report

Date: 2026-11-20. Scope: milestone M2 only ([`docs/05-implementation-plan.md`](../docs/05-implementation-plan.md) §3,
[`HANDOFF.md`](../HANDOFF.md) §4). No folding code exists yet; `engine-adapter.js`, `fold-runner.js`,
`summarizer.js`, `recall.js`, `hints.js` and the client are M3–M6 and were not written.

## 1. Environment

| Fact | Value |
|---|---|
| dsh | 0.2.2-rc.5 (`~/.dsh/runtime`) |
| Node / pnpm | v24.19.0 / 11.19.0 |
| Host | Linux 6.17.13-2-pve, x86_64, Debian 13 |
| Scratch Harness home | `<repo>/.m2-scratch/dsh-home` (deleted after the runs) |
| Profile | `m2`: `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-headless` + `dsh-task-folding` |
| Plugin install | `dsh plugin --profile m2 add <repo>` → `dsh-task-folding: link:/home/developer/repo/dsh-task-folding` |
| Working directory of the sessions | `<repo>/.m2-scratch/work` |

Isolation as in M0: a scratch `DSH_HOME` inside the workspace, the credential file copied in (`mode 600`),
and `npm_config_store_dir` / `XDG_*` pointed inside the workspace. **No existing profile was created,
installed into, reconfigured or written.** `~/.dsh/profiles` still holds exactly `node_modules`, `rescue`,
`web`; `~/.dsh/profiles/web/package.json` is untouched (17 bundles, mtime 2026-11-20 11:52). The one
recent write under `~/.dsh` (`profiles/web/cordis.patch.yml`, 22:29) is the running Web host persisting
this session's model selection through `config-editor`; no command in this milestone touched `~/.dsh`.

Commands, in order (trimmed; `<S>` = `<repo>/.m2-scratch`):

```sh
mkdir -p <S>/dsh-home && cp ~/.dsh/.credentials.yaml <S>/dsh-home/.credentials.yaml && chmod 600 …
export npm_config_store_dir=<S>/pnpm-store XDG_CACHE_HOME=<S>/xdg/cache XDG_CONFIG_HOME=<S>/xdg/config \
       XDG_DATA_HOME=<S>/xdg/data XDG_STATE_HOME=<S>/xdg/state
DSH_HOME=<S>/dsh-home dsh --profile m2 --from-default-profile headless --dump-config > <S>/dump-m2.txt
DSH_HOME=<S>/dsh-home dsh plugin --profile m2 add <repo>          # rc=0
DSH_HOME=<S>/dsh-home dsh --profile m2 --dump-config > <S>/dump-m2-plugin.txt
# then the scripted sessions of §3, each a separate process
node scripts/replay-journal.js <session>/session.v4.jsonl.zstd [--decode]
```

The profile's `cordis.patch.yml` re-enabled `credentials`, `authorization` and `deepseek-account`, which
the headless template disables (same patch as M0). Nothing else was overridden, apart from §5.

## 2. What the plugin does now (verified, not planned)

- Registers `task_begin`, `task_end`, `fold_recall` and the `task-folding` prompt section (order 650).
- Registers the `taskFolding` projection (`stateVersion 1`) with a `wire` view and a validating
  `stateSchema` / `viewSchema`; tools read state through `handle.stateOf(session)`.
- Writes the only durable state it has: `tool/result.data.meta` (`BeginMeta` / `EndMeta`).
- Refuses nested PTC calls, empty titles, unknown ids and bad `outcome`; writes no meta on failure.
- Prompt surface: 601 + 442 + 914 + 833 = **2,790 characters**, inside the 3,400 budget
  (`test/prompt-budget.test.js`); the design's estimate in `docs/04` was exact.

## 3. Scripted sessions

Each run is a separate `dsh` process; every second-and-later run resumes with `--session-id`, so the
projection was replayed from the log on every step. Prompts asked for the behaviour in words; no tool
argument was scripted.

| # | Session | What was asked | Result |
|---|---|---|---|
| 1 | `6ea3c092` (smoke) | open a task, close it at once | `T1 below-floor`, `estTokens 68` — the render text was `Task T1 closed; it is small, so its messages stay as they are. No open tasks.` |
| 2 | `5b7b398c` | open `outer`, open nested `inner`, read `a.md`/`b.md`; in ONE message close `inner` + open `sibling`; read `c.md`; close `sibling`; close `outer` | see §4.1 |
| 3 | `71a5bf9b` | open `parent`, open `child`, read two 300-line files; close `parent` while `child` is open; then (new process) open `after restart`, read a file, close it | see §4.2 |
| 4 | `d5a72f77` | same shape as #1, but with `minSpanTokens: 0` in the profile patch | see §5 |

### 4.1 Session 2 — nesting, relay, all below the floor

`node scripts/replay-journal.js` on the decoded journal (trimmed; fixture `test/fixtures/logs/m2-nested-relay.jsonl`):

```
T1  outer    parent=-   depth=0  status=below-floor  verdict=below-floor  est=1999  chars=1277  beginCut=21  spanStart=25  endCut=105
T2  inner    parent=T1  depth=1  status=below-floor  verdict=below-floor  est=655   chars=827   beginCut=27  spanStart=31  endCut=54
T3  sibling  parent=T1  depth=1  status=below-floor  verdict=below-floor  est=724   chars=972   beginCut=54  spanStart=58  endCut=88
open=[] nextId=4 assistantCount=12
```

- Parents and depths are right; nothing is left `opening`/`closing`; the stack is empty at the end.
- **The relay worked**: `endCut(T2) == beginCut(T3) == 54`, and the two calls do come from one
  `assistant/message` (`test/m2-journals.test.js` checks both facts against the journal).
- Every task landed `below-floor` because the work was three one-line file reads: the largest span was
  1,999 tokens — one token under the default 2,000 floor.

### 4.2 Session 3 — merge and resume

Fixture `test/fixtures/logs/m2-merged-resume.jsonl`:

```
T1  parent        parent=-   depth=0  status=queued  verdict=queued  est=14164  chars=1173  beginCut=21  spanStart=25  endCut=52
T2  child         parent=T1  depth=1  status=merged  verdict=null    est=-1     chars=0     beginCut=27  spanStart=31  endCut=52
T3  after restart parent=-   depth=0  status=queued  verdict=queued  est=6598   chars=799   beginCut=69  spanStart=73  endCut=81
open=[] nextId=4 assistantCount=10
```

- `task_end(id: T1)` while `T2` was open returned
  `Task T1 closed; it will be folded into your summary. No open tasks. Subtasks closed with it: T2.`
  and the reducer marked `T2` `merged`, with no verdict and no `endMsgSeq` of its own.
- `T1` and `T2` are unchanged after the restart, and the resumed session's new task took id `T3` — the
  id sequence follows the log, not the process.
- The two tasks that did real work (`T1`, `T3`) came out `queued` with `estTokens` 14,164 and 6,598.

## 5. Settings and `Config` (the config probe)

`host/settings.js` builds the `Config` schema from `@deepseek-ai/schemastery`, which the plugin can only
reach through the runtime-anchored fallback in `host/resolve.js`. To prove the wiring live, the profile
patch was given one override:

```yaml
- id: dsh-task-folding
  config:
    minSpanTokens: 0
```

The next session's task closed as `delegate` (`est=362`, `chars=872`): with the floor removed the span was
usable, and an 872-character summary is more than `maxSummaryRatio` (0.5) of a 362-token span. With the
default floor the same work is `below-floor`. The override was then removed; fixture
`test/fixtures/logs/m2-config-override.jsonl` pins the `delegate` verdict (it is the only live journal with
that verdict) and is replayed only for its state, not as a default-configuration example.

## 6. Q4 — peer dependencies

Question (`docs/07-open-questions.md` Q4): does declaring the host packages as `peerDependencies` make
`dsh plugin add <local path>` link them?

**No.** After `add`, the profile's `node_modules` contains exactly one entry — the plugin's own symlink
(`dsh-task-folding -> ../../../../..`) — and no `@deepseek-ai/*` directory at all. Consequences:

1. A bare `import('@deepseek-ai/schemastery')` from the linked package fails, as M0 predicted.
2. `host/resolve.js`'s fallback is what makes the schema builder available; without it the plugin would
   start with defaults and no `Config` (it is written to survive that, but the live run proves the
   fallback path works, because §5's override took effect).
3. The host printed no warnings: neither `dsh plugin add` nor the run reported an unmet peer requirement,
   and `--dump-config` shows the row as `- id: dsh-task-folding / name: dsh-task-folding`. The peers are
   still worth declaring — `packages/app-boot/src/plugin-compatibility.ts` gates the plugin on their
   ranges against the **runtime** version — so they stay in `package.json`, marked
   `peerDependenciesMeta.optional` so that a dev install of this repository does not pull the whole host.
   The host ignores that flag when gating (`docs/02-host-api.md` §1).

## 7. Deviations from the design, and the doc change each one made

1. **`task_end`'s output value carries more than the documented four fields.** `presentationMeta(args, value)`
   receives no `exec`, so the meta's `estTokens`, `summaryChars`, `outcome` and `callId` must travel on the
   value; `render` shows none of them. → `docs/04-tools-and-prompt.md` §1.
2. **`absorbed` covers any absorbed boundary, not only `beginCut`.** `docs/03` §6.2 said `beginCut === -1`;
   the implementation uses `isAbsorbed(task)` so that a span start swallowed by a replacement also yields
   `absorbed` (with `estTokens: -1`) instead of a misleading `below-floor`. → `docs/03-architecture.md` §6.2.
3. **`peerDependenciesMeta.optional`** was added, see §6. → `docs/02-host-api.md` §1/§9, `docs/07` Q4.
4. **`scripts/journal.js` extracted** from `scripts/replay-journal.js` so the replay script, the decode step
   and `test/m2-journals.test.js` share one concatenated-frame decoder; the script gained `--decode`.
5. **`fold_recall` implements only the no-argument fold list** and answers `RECALL_NOT_AVAILABLE` for
   arguments — explicitly allowed for M2 by `HANDOFF.md` §4.1; the full recall is M4.

No change was needed to the architecture, the projection or the cut model.

## 8. What surprised me

- **Tool errors are model-facing text.** The host wraps a thrown error as `content: [{ type: 'text',
  text: 'Error: <message>' }]` with `isError: true` and no meta (`pipeline.ts` L719). So the error strings
  live in `host/texts.js` together with everything else the model reads, and each one is prefixed with the
  tool name ("`task_end failed: …`") because the host adds only "Error: ".
- **Nothing validates tool arguments.** The registry validates the returned value against `output.schema`,
  but `exec.arguments` reaches `execute` unchecked by both the registry and `dsh-tool-executor-native`.
  Every argument the tools read is therefore defended by hand (wrong types, missing `summary`, an id that
  is not a string).
- **The supported JSON-schema subset has no type arrays.** A nullable field must be
  `oneOf: [{ type: 'string' }, { type: 'null' }]`; `type: ['string', 'null']` is refused at registration.
- **Other tools' meta shares the same slot.** `read` writes its own `data.meta` (path, offset, lines), so
  anything that scans `tool/result.data.meta` must filter on `tf === 1`; the reducer already does.
- **Sequential commit makes two begins in one batch nested.** M0 recorded that a call's result is
  committed before the next call starts, so a second `task_begin` in the same message sees the first task
  open and becomes its child, not its sibling — `docs/03` §6.1 said the opposite ("acceptable: siblings")
  and was corrected in this milestone. The reducer handles the nesting (closing the parent merges the
  child) and the live model never hit the case; `test/tools.test.js` pins the behaviour.
- **A `Config` value that breaks the schema fails at activation**, not in the reader: schemastery rejects
  an out-of-range `config` when the row mounts (`.min()`/`.max()` in `host/settings.js`). The clamping in
  `readSettings` is the second line of defence — it matters when `Config` is absent (no schemastery) or when
  a value arrives from somewhere other than the schema.
- **The floor is easy to miss.** A whole three-task session stayed under 2,000 tokens per task because the
  reads were one line each; that is the intended behaviour, but it means the default `minSpanTokens` makes
  small sessions fold-free by construction.

## 9. Deliverables and checks

- Code, packaging, tests and docs committed to `main` in five commits: texts/settings/resolver/estimator;
  tools + view schema; entry point + bundle manifest; live fixtures + journal reader; docs (this report).
- `npm test` — 92 tests pass (53 before M2). `npm run coverage` — 100% branch/line/function for
  `host/projection.js` and `host/cuts.js`. `npm run typecheck` and `npm run lint` clean. CI runs the same.
- Fixtures: `test/fixtures/logs/m2-{nested-relay,merged-resume,config-override}.jsonl`, scrubbed (home path
  → `~`, no keys, tokens or e-mail addresses), replayed by `test/m2-journals.test.js`.
- The scratch home `.m2-scratch/` was deleted after the runs; it is git-ignored in the meantime.

Stopping here: M3 (self-summary folding) is not started.
