# Handoff — continuing dsh-task-folding inside DeepSeek Harness

You are a coding agent running inside DeepSeek Harness (DSH) on the developer's machine. This file is your brief. Read it fully, then `AGENTS.md`, then the documents it points to. Everything in this repository is English-only — code, comments, docs, commit messages, model-facing text.

Last updated: 2026-11-20, after milestone M1 (commit `90c79f4` and later).

## 1. What this project is

A DSH plugin: the agent wraps work in tasks (`task_begin` / `task_end`); each finished task is folded into a short summary that the model itself wrote in `task_end`; the originals stay in the session log and can be read back with `fold_recall`. It replaces the earlier `yindf/taskfold` plugin, whose problems are listed in `docs/01-background.md`.

## 2. Where things stand

| Milestone | Status | Where |
|---|---|---|
| Design | done | `docs/` (start at `docs/README.md`) |
| M0 — live-host verification | done | `m0/REPORT.md`, `m0/sessions/` (decoded journals), answers in `docs/07-open-questions.md` |
| M1 — pure core | done | `host/projection.js`, `host/cuts.js`, `host/planner.js`, `host/types.js`, `test/` |
| **M2 — tools without folding** | **your job** | section 4 below; plan in `docs/05-implementation-plan.md` |
| M3–M8 | not started | do not start them |

Checks that must stay green (all pass at handoff): `npm test` (53 tests), `npm run coverage` (100% for `projection.js` and `cuts.js`), `npm run typecheck`, `npm run lint`. CI runs the same on every push to `main`.

## 3. Read before writing code

1. `AGENTS.md` — the hard constraints. The ones most likely to bite in M2: never append session events; never parse model-facing text for state; all model-facing strings in `host/texts.js`; no runtime dependencies.
2. `docs/03-architecture.md` §4.1 (meta payloads), §6 (tool behavior), §10 (settings), §11 (failure modes).
3. `docs/04-tools-and-prompt.md` — the exact schemas, rendered texts, prompt section and budget.
4. `docs/02-host-api.md` — every host API you may use, with live-verified facts marked **[live]**. If you need anything not listed there, verify it in the host source first (the `dsh-doc` skill and `~/.dsh/runtime/node_modules/@deepseek-ai/*`) and add it to that file in the same commit.
5. `host/projection.js` — what the reducer expects from your meta. Your tools must produce exactly `BeginMeta` / `EndMeta` from `host/types.js`; the reducer ignores anything else.

## 4. M2 — tools without folding

Goal: the plugin installs into a profile; the model can open and close tasks (nested, and relayed in one message); verdicts land in the log as `meta`; the projection is live. **No folds yet** — do not write `engine-adapter.js` or touch compaction.

### 4.1 Files to create

| File | Content |
|---|---|
| `host/texts.js` | Every model-facing string: prompt section, tool descriptions, parameter descriptions, rendered results, error texts. Copy from `docs/04-tools-and-prompt.md`; keep them as exported constants and small render functions. |
| `host/settings.js` | The `Config` schema and clamping readers (03 §10). Fields are `.volatile()`; read them with `config.<field>.get()` (that is how DSH's own plugins read volatile config, e.g. `packages/subagent/subagent/src/index.ts`). Readers clamp invalid values to defaults instead of throwing. |
| `host/resolve.js` | Load `@deepseek-ai/schemastery`: bare `import()` first; if that fails (a `dsh plugin add <local path>` install is a pnpm `link:`, and Node resolves its real path — see 02 §9), fall back to `createRequire` anchored at the DSH runtime: `fs.realpathSync(process.argv[1])`, walk up to the `node_modules` that contains `@deepseek-ai/schemastery`. Read-only; never write files. Return `null` if both fail; `index.js` then runs with defaults and no `Config`. |
| `host/estimate.js` | Span estimate: sum of `ctx.tokenMeter.estimateMessage(session.deriveEventMessage(session.eventAt(seq)))` over surface nodes from the task's `spanStart` to the current tail (`session.surface.nodes`). Skip nulls. Cache per `(session id, seq)` in a bounded `Map` — a seq's message never changes, replacements get new seqs. Also `estimateText(text)` via `estimateMessage({ role: 'user', content: [{ type: 'text', text }] })`. |
| `host/tools.js` | `task_begin`, `task_end`, `fold_recall` definitions (`fold_recall` may return a fixed "not available until folding is implemented" text in M2, or implement only the no-argument list from `state.folds`; full recall is M4). |
| `host/index.js` | The plugin object (`name`, `inject`, `Config`, `apply`). Registers the projection (`await ctx.sessionProjections.register({ key, stateSchema, init, apply, stateVersion, wire: { viewSchema, view } })` — it returns a promise; tools may `await` the same promise), the tools, and the prompt section (`ctx.systemPrompt.section({ name: 'task-folding', order: 650, text })`). If registering `task_begin` fails because the name exists (taskfold installed), stay inactive and report it once through the host's logger. |
| `package.json` | Add: `"main"`/`"exports"` (`.` → `./host/index.js`, `./locale/*.json`, `./icon`), `"files"`, `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`, `peerDependencies` (`@deepseek-ai/dsh`, `@deepseek-ai/dsh-compaction-basic`, `@deepseek-ai/dsh-llm`, all `^0.2.2-rc.1`). Remove `"private": true` only at release (M7). No client yet (M6). |
| `cordis.patch.yml` | One row: `- insert: [{ id: dsh-task-folding, name: 'dsh-task-folding' }]` (same shape as `m0/probe-bundle/cordis.patch.yml`). |
| `locale/en.json` | `meta.title` ("Task folding", sentence case) and `meta.description` — state only implemented behavior. Follow the `dsh-doc` skill's `host-plugin.md` "Display metadata" checklist. |
| `icon.svg` | An original, simple icon (see the `dsh-doc` skill's `artwork.md`). |

### 4.2 Tool behavior (summary of 03 §6 — the docs win if they differ)

`task_begin({ title })`
- Refuse nested PTC calls: `exec.callId !== exec.rootCallId` (live-verified; `rootCallId` alone is set for every call).
- Normalize the title: collapse whitespace, remove newlines, trim, cap at 120 characters; empty → error.
- `id = 'T' + max(state.nextId, reserved)`; keep an in-memory per-session high-water mark `reserved` and bump it (the native executor is sequential, so this is only a guard).
- `parent` = last element of `state.open`, or `null`.
- Return `{ ok: true, id, title, parent, depth }`; `output.presentationMeta` returns `{ tf: 1, op: 'begin', id, title, parent }`.

`task_end({ summary, id?, outcome? })`
- Refuse nested PTC calls.
- Target: `id` if given and in `state.open`, else the last element of `state.open`. No open task, or an unknown id → error listing open ids.
- `merged` = open tasks after the target in `state.open`.
- Verdict, in order: target's `beginCut === -1` → `absorbed`; target status `opening` (begun in this same batch) → `below-floor`; `estTokens < minSpanTokens` → `below-floor`; summary shorter than `minSummaryChars`, or `estimateText(summary) > maxSummaryRatio × estTokens` → `delegate` if `delegateEnabled`, else `queued`; otherwise `queued`.
- Return `{ ok: true, id, verdict, merged, remaining }`; meta `{ tf: 1, op: 'end', id, merged, verdict, outcome, estTokens, summaryChars, callId: exec.callId }`.
- Errors throw (or return the host's error shape) and produce no meta — check how DSH tools report errors in `packages/core/tools/src/contracts.ts` / `pipeline.ts` and do the same.

Read state with `(await projection).stateOf(exec.agent.session)`.

### 4.3 Tests to add

- `test/tools.test.js` with a fake `exec` (`{ callId, rootCallId, agent: { session } }`), a fake session (`surface.nodes`, `eventAt`, `deriveEventMessage`, `id`) built from `test/fixtures/sim.js`, and a fake `tokenMeter`. Cover: ids, parents, PTC refusal, title normalization, every verdict branch, merged, errors, render text per verdict, meta shape accepted by `isBeginMeta` / `isEndMeta`.
- End-to-end in the simulator: drive `Sim` with meta produced by the real tool functions instead of `Sim.beginMeta` / `endMeta`, and check the projection reaches the same state.
- `test/prompt-budget.test.js`: the prompt section plus the three schemas (compact JSON) ≤ 3,400 characters (04 §4).
- `test/settings.test.js`: clamping and defaults.
- `npm run coverage` must stay at 100% for the pure modules; aim high for the rest.

### 4.4 Live acceptance (on this machine)

Use the same isolation as M0 (see `m0/REPORT.md` "Deviations"): a scratch `DSH_HOME` inside the workspace, the credential file copied in, pnpm store/XDG dirs pointed inside the workspace. **Never touch the existing profiles in `~/.dsh`.**

1. Create a headless scratch profile with bundles `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-headless`, and this repository (`dsh plugin --profile <p> add <absolute path to the repo>`). Record the composed config (`--dump-config`).
2. Check `peerDependencies` handling (open question Q4): after `add`, does the profile's `node_modules` gain links for the declared peers? Does the host warn about them at startup?
3. Run one scripted session with `dsh --profile <p> --json "<task>"` and follow-ups with `--session-id <id>`. Ask the model, in plain words, to: open a task "outer"; open a nested task "inner"; read two files; in ONE message close "inner" with a summary and open "sibling"; read one file; close "sibling"; close "outer". Then a second run where it closes "outer" while a subtask is still open (merged). Let the model choose wording; do not script tool arguments.
4. Decode the journal and replay it through the projection: `node scripts/replay-journal.js <session.v4.jsonl.zstd>` (handles concatenated zstd frames). Expected: every task has the right parent, verdicts match the tool results, the relay produced `endCut(inner) == beginCut(sibling)`, merged children are `merged`, nothing is left `opening`/`closing`.
5. Restart and resume the same session (`--session-id`), run one more task, replay again: the earlier tasks are unchanged.
6. Copy the decoded journals (scrubbed: no keys, tokens, e-mails; home path → `~`) to `test/fixtures/logs/m2-*.jsonl` and add a snapshot test that replays them.

### 4.5 Deliverables

- Code, tests and docs committed to `main` in small logical commits (see `AGENTS.md` "Commits"). Push when green.
- `m2/REPORT.md` with: environment (DSH version), what was run, the replayed final state of each live session (trimmed), Q4 findings, any deviation from the docs and the doc change you made for it, and anything that surprised you.
- Update `docs/05-implementation-plan.md`: mark M2 done with a one-paragraph result, as M0/M1 are.
- Then **stop** and report. Do not start M3.

## 5. Things learned the hard way (do not rediscover)

- `tool/result` replacements made by the tool-result pruner keep the original `meta`. The reducer already ignores replacements; never "fix" that.
- `user/message` data is the message itself (`data.content`, `data.source`); `tool/result` and `assistant/message` wrap it in `data.message`.
- Session journals are concatenated zstd frames; `zlib.zstdDecompressSync` on the whole buffer silently returns only the first frame. Use `scripts/replay-journal.js` or its `decodeZstd`.
- A profile with both `dsh-web-app` and `dsh-headless` hands the whole command line to the web app; use a headless-only profile for scripted runs.
- `~/.dsh` was read-only to the M0 agent's sandbox; `dsh plugin add` needed `npm_config_store_dir` and `XDG_*` pointed into the workspace.
- `cordis_inspect` was not available in the M0 session; do not plan on it.
- `ctx.slots.inject` with a misspelled slot fails silently (relevant later, in M6).

## 6. When something does not fit

If the design is wrong or a host fact differs from `docs/02-host-api.md`: change the code to match reality, update the doc in the same commit, add an ADR for a real decision, and list it in `m2/REPORT.md`. If you are blocked (missing credentials, a command that does not exist), write it down in the report and finish what you can. Do not weaken tests to make them pass.
