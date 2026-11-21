# 08 — Follow-ups and the work order after M3

What is left, in the order it should be done, and every defect or debt found while building M0–M3.
Milestones are defined in [05](05-implementation-plan.md); this document says what to do *first* and
why, and keeps the small repairs that do not belong to a milestone.

Priorities: **P0** blocks the next milestone or is a wrong claim in the docs; **P1** costs time or
trust when it happens but does not block; **P2** is worth doing when convenient.

## 1. Repairs before M4 (do these first, as one or two commits)

| ID | Problem | Why it matters | Fix | Acceptance |
|---|---|---|---|---|
| F1 | **Done in `host/runtime/scheduler.js`.** A task can close `queued` and end up `absorbed` because the realm's compaction won the boundary: our pass gets `busy`, stops silently, and the realm checkpoint then swallows the span (M3 live, `m3/REPORT.md` §7.2) | The model was told "it will be folded" and nothing is folded; silent, so nobody can see why | On `busy`, re-read the state once and retry the same task after the pass when the durable lock is gone; log one line per task when the pass gives up on a busy lock. Document the contention in 03 §5.5 | A runner test where the engine throws `busy` and then succeeds within the same boundary pass; a second one where it stays busy and one log line appears |
| F2 | **Done in `host/domain/estimate.js` + `test/perf.manual.js`.** The first folding boundary in a fresh process cost 6–17 ms on an 80k-event log (cold per-seq estimate cache), ~2.4 ms after | Inside the 100 ms budget, but it is the only part of the fold path that grows with the log | Warm the estimate cache for the region before the transaction, or keep a prefix-sum per `surface.replaceGeneration` | `test/perf.test.js` measures the *first* folding boundary under 10 ms too |
| F3 | **Done in this commit.** `README.md` said "No plugin code yet; next is M1" and `docs/07` called Q4 "peers unverified" | Wrong claims mislead the next agent and the reader | README and Q4 updated to M3 reality; Q13 added | `grep` finds no stale status line |
| F4 | **Done in `.github/workflows/contract.yml`.** `scripts/contract-check.js` needs network, so CI never runs it | ADR 0004 promises that a host refactor is caught in CI | Add a `contract` workflow with `schedule` + `workflow_dispatch` (never on push), and mention it in 06 | The workflow file exists; a manual run is recorded green |
| F5 | **Done.** Settings `staleTaskSteps`, `showTaskBar`, `summarizationProvider`, `summarizationModel` exist and are documented, but nothing reads them yet (M5/M6/M7) | A user who sets them sees no effect; a reviewer may think they are broken | 03 §10 now says which four fields are live and that no settings UI may expose the others before M5/M6 | 03 §10 carries the note; `test/settings.test.js` unchanged |
| F9 | **Done in `9b74d0d` (migration step 3 of docs/10).** The projection now carries `surfaceEpoch`, the runner reads a `Snapshot { state, nodes, epoch }`, every generation and every skip is bound to the epoch it was decided at, and the snapshot is re-read after the pass's suspension point. `test/f9-surface-epoch.test.js` is the acceptance test; `test/runner-edges.test.js` covers a skip that stops applying when the surface moves | A rare external-compaction race cost a task every later fold in that session | Fixed by ADR 0007 (surface epoch), not by re-reading alone: a skip is now a statement about a version | The task folds at the boundary after a replacement during `startDelegate` |
| F8 | **Done.** `dsh.client.inject` names `@deepseek-ai/dsh-client-ui-conversation`, which was declared nowhere, so nothing verified the package existed in the profile; if it is missing, the dock slot is silently empty (docs/02 §10 warns that slot misses are silent) | A user on a profile without that client package sees no dock and no error | The injected package is now an optional peer (`^0.2.2-rc.1` + `peerDependenciesMeta.optional`): a profile that does not install it stays legal, `npm pack` ships no copy, and `npm run contract` does not start requiring it. `test/manifest.test.js` checks offline that every `dsh.client.inject` name is a declared optional peer in the host range convention (or a `@deepseek-ai` package the tarball bundles), with a negative self-test for the undeclared, non-optional and wrong-range forms | A broken injection fails the manifest contract in the working tree, and `scripts/e2e-browser.js` proves the live side by finding both packages in the boot graph |
| F7 | **Done — environment, not this plugin.** In the M6 scratch web profile a setting written from the configuration card left `cordis.patch.yml` untouched (the built-in `Subagent` page behaved the same). Re-run in a spec-following scratch home (`DSH_HOME=<repo>/.f7-scratch`, profile `f7` from `--from-default-profile web`, plugin added as a link): the write lands, so the M6 scratch composition or check was at fault, not `configForms.set`. Evidence chain: toggle `showTaskBar` on/off on the plugin page → `<profile>/cordis.patch.yml` gains `showTaskBar: true` and then `false` (the same document the built-in `Subagent` page writes `maxDepth: 2` to, and the Preview Notice writes `ui-settings-general` to); the value survives a page reload and a `dsh` restart with the patch unchanged; server stderr shows no settings error | If a real profile also refuses writes, the card would look live but change nothing | Kept the card unchanged (its write path is correct) and turned the evidence into `scripts/e2e-browser.js`: boot graph, card render, on/off writes matched against the patch on disk, dock shown and hidden live, and the off value surviving a reload | `node scripts/e2e-browser.js --url <token URL> --patch <profile>/cordis.patch.yml` prints ten PASS lines; restart persistence was checked by hand and is recorded here |
| F6 | **Done in `docs/02` §6.** A realm engine whose config has `thresholdRatio <= retainRatio` fails to mount, `ctx.compaction` disappears, and only a `dsh: warning: N entries did not activate` line says why (found in M3) | Looks like "compaction stopped working" with no obvious cause; our plugin keeps folding, which hides it further | Add a troubleshooting note to `docs/02` §6 near the construction section | The note exists and names the exact message |

## 2. Milestones in order

The order is the one in [05](05-implementation-plan.md), with two changes after M3.

### M4 — Recall (next)

`host/tools/recall.js`, the full `fold_recall` shapes of [04](04-tools-and-prompt.md) §1 (index, range, grep,
paging), the nested fold tree, and the message brief renderer. The fold node already advertises
`fold_recall({ task: "T7" })` in its footer, so until M4 ships that promise is unfulfilled (F9).

Acceptance: recall output equals `deriveEventMessage` of the fold's `shadowedSeqs`, in order; nesting
shown; caps and the truncation note enforced; no file is written; `m3-*.jsonl` fixtures grow the
expected recall strings.

### M5 — Delegate fallback

`host/ports/llm.js` (prefix-anchored request, instruction, validation) and the two-phase runner
(background generation, commit at the next boundary). It also settles two open questions:
**Q11** — the durable failure record from a rejecting `summarize()` — and **Q12** — the provider cache
hit ratio for the delegate request (`scripts/verify-cache.js`). Everything the M3 adapter learned about
error classification applies: only `busy` is a `ManualCompactionError` on this path.

Acceptance from 05: a task closed with an empty summary folds after its summary is generated, with no
step or user message waiting on generation; three consecutive failures stop retries across a restart;
cache-read ratio ≥ 80 % on delegate folds.

### M6 — Hints and the dock

`host/prompt/hints.js` (buckets 25/50/100, durable latch via `source.kind`) and the client module: the dock in
`conversation.input.dock` plus the settings card. `showTaskBar` and `staleTaskSteps` become real here
(F5 note is removed in the same commit).

### M7 — Evaluation and release

Q5 (mid-history framing), Q6 (`deferLoading` for `fold_recall`), and the tuning of `minSpanTokens` /
`maxSummaryRatio` from measured data. The M3 numbers are the baseline: folds cost ~2.4 ms per boundary,
summaries of real work ran 1000–1700 characters, small tasks 180–270 after the M2 guidance change, and
`outer` tasks whose children were folded end `below-floor` (F3 in §1 above is the decision to make
here). Then README, `0.1.0`, npm publish.

### M8 — Upstream proposal (parallel, no dependency)

`compactRegion(start, end, agent, signal, { summary })` or a `compaction/summarize` waterfall, plus an
option to replace the checkpoint preamble (Q5). If accepted, `engine-adapter.js` is deleted and the
plugin moves to `inject: ['compaction']`.

## 3. Decisions to make, not tasks yet

| ID | Question | When |
|---|---|---|
| Q13 | Should a span that consists only of fold nodes be collapsed too (an `outer` task after its children were folded)? It saves little context but simplifies the tree | M7, with the evaluation data |
| Q14 | Should a `below-floor` task with a *long* summary be re-checked after later folds (its span can grow when a sibling is absorbed)? Today the verdict is final | M7 |
| Q10 | Implicit per-turn task for models that ignore the discipline | after M7 (already in 07) |

## 4. Known risks carried forward

| Risk | Where it bites | Mitigation |
|---|---|---|
| The host changes `BasicCompactionEngine` internals | folds stop | `npm run contract` on a schedule (F4), one adapter module, upstream proposal (M8) |
| The prompt surface grows past 3,400 characters while M4/M5 add schemas | every request | `test/prompt-budget.test.js` fails first; the budget has 484 characters of headroom today |
| A second compaction (realm, pruner) wins a boundary | a `queued` task becomes `absorbed` | F1, and 03 §5.5 documents the contention |
| Estimate-cache memory on a very long session | host memory | bounded per session (`host/domain/estimate.js`), re-check in M7 on a real long log |
| Model discipline: tasks never closed | nothing folds | stale-task hint (M6), realm compaction as the safety net |
