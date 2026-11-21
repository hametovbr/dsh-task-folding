# M7 — Evaluation and release

Date: 2026-11-21. Scope: milestone M7 ([`docs/05-implementation-plan.md`](../docs/05-implementation-plan.md) §3).

## 1. What this milestone decided

| Item | Outcome |
|---|---|
| Q5 — checkpoint framing | **Answered:** the framing is a host constant; not ours to write; M8 asks for a `framing` field. Harmless as used. |
| Q6 — `deferLoading` for `fold_recall` | **Rejected after measuring it:** ≈ 208 tokens saved, but the host has no load path for a deferred baseline tool, and a live run showed the model then never calling the tool. Reverted. |
| Q13 — outer task after its children folded | **Answered:** keep `below-floor`; a summary of summaries loses what recall exists for. |
| Q14 — re-checking `below-floor` | **Answered:** final; re-checking costs O(tasks) per boundary for a case the cuts make impossible. |
| Q15 — begin packed with the first reads | **Fixed at the prompt:** `Call task_begin in its own message, before the work it covers.` Live: 3/3 runs kept the begin call out of the read batch and the reads inside the span; a 13.6k-token span then folded. |
| Defaults | **Unchanged** (`minSpanTokens` 2000, `maxSummaryRatio` 0.5, `staleTaskSteps` 25): see §4. |

Also new: `scripts/eval-report.js` — the metrics of [docs/06 §5.3](../docs/06-testing.md) computed from
journals (`node scripts/eval-report.js "C=a.jsonl" "C=b.jsonl" …`), 14 tests, every metric carrying the
field it came from and every unsupported one reported as `n/a (why)` instead of a zero.

## 2. The suite: what was actually run

**This is a reduced suite, and the numbers must be read that way.** The protocol asks for 10–20 tasks of
50–300 steps, three runs each, across four configurations — 120–240 sessions. This session ran **7
sessions**: two tasks (a four-file documentation summary; a bug fix with a failing test) × the
configurations A (no plugin), B (`dsh-taskfold@0.40.1`), C (this plugin, `self`), D (this plugin,
`delegate` forced by `minSummaryChars: 9000`), one to two runs each, model `deepseek-flash`, host
0.2.2-rc.5.

Reproduce: `m7/metrics.md` (the raw report), the journals under the scratch home that produced it, and
this exact command shape:

```sh
node scripts/eval-report.js "A=<journal>" "B=<journal>" "C=<journal>" "D=<journal>"
```

## 3. Measured

From [`m7/metrics.md`](metrics.md) (aggregate table):

| Config | Sessions | Main requests | Main tokens | Cache-hit | Fold requests | Fold tokens | Folds | Steps |
|---|---|---|---|---|---|---|---|---|
| A — no plugin | 2 | 13 | 189,134 | 86.2 % | — | — | 0 | 13 |
| B — taskfold 0.40.1 | 2 | 15 | 245,412 | 87.3 % | 1 | 27,953 | 1 (delegate) | 15 |
| C — this plugin, self | 2 | 21 | 307,948 | 89.9 % | — | — | 1 (self) | 21 |
| D — this plugin, delegate | 1 | 12 | 219,965 | 90.3 % | 1 | 24,155 | 1 (delegate) | 12 |

**All tasks succeeded in every configuration** (the table was written; the test suite passed).

What the numbers say, without flattering the plugin:

- **The acceptance criterion "billed tokens ≤ taskfold" is not met on this suite:** C bills 307,948
  against B's 245,412. That is not the fold mechanism — C's folds cost **zero** billed fold tokens
  (self fold, no LLM call) while B's one fold cost 27,953 — it is the **discipline**: the prompt section
  produces more steps (21 main requests against 15) and every step pays its prefix. On tasks this short
  the added bookkeeping costs more than the folds save, which is exactly why the protocol asks for
  50–300-step tasks.
- **Cache-hit is better, and the delegate fold keeps it:** C 89.9 %, D 90.3 %, against A 86.2 % and
  B 87.3 %. The D run's fold asked the provider for 23552 cached tokens against 210 fresh ones —
  **99.1 %**, +0.5 pp against that session's median main request (98.7 %), well inside the 10 pp
  tolerance of [03 §12 invariant 9](../docs/03-architecture.md).
- **Folds are cheap in `self` mode and cheap in `delegate` mode:** 13,088 tokens of span became one
  summary node for 210 fresh input tokens and 441 output tokens.
- Task success was equal everywhere; nothing regressed, and no task-tool call was rejected in any run
  (`Rejected = 0`).

**What would settle the acceptance criterion:** the same suite at the protocol's scale — long tasks,
three runs, and the interquartile ranges of §5.4 — where the fold saving compounds across 50+ steps
instead of being paid once. Until that runs, this report says the mechanism is sound and its cost on
short tasks is higher than taskfold's, and does not claim the published comparison.

## 4. Defaults

Unchanged, with the reasons the data supports:

| Setting | Value | Why it stays |
|---|---|---|
| `minSpanTokens` | 2000 | The folded span was 13,088 tokens; the tasks that stayed `below-floor` were 346–1,428 tokens. Lowering the floor would fold summaries of two files, which costs more than it saves. |
| `maxSummaryRatio` | 0.5 | No run produced a summary near half its span; the guard never fired. |
| `staleTaskSteps` | 25 | The hint did not fire in these runs (2–21 steps); its live behaviour was measured in M6 at 5. |
| `showTaskBar` | false | Unchanged; the dock is opt-in. |

## 5. Release preparation

- `package.json` → `0.1.0` (lockfile synced); `exports["./client"]` fixed in M6 and re-verified here.
- `README.md` rewritten: what it does, install, tools, all eight settings, the measured cache-hit, the
  development commands.
- **Not published:** `npm publish` needs a token and an explicit go-ahead that this session does not
  have, and the acceptance criterion above is not met. The tree is release-ready (`npm pack` lists the
  documented files, `files` covers `host`, `client`, `cordis.patch.yml`, `locale`, `icon`); the release
  step is one command once the owner says so.

## 6. Gates

| Gate | Result |
|---|---|
| `npm test` | 231 tests, all pass |
| `npm run coverage` | 100 % branch/line/function for `host/projection.js` and `host/cuts.js` |
| `npm run typecheck`, `npm run lint` | clean |
| `npm run perf` | 4 guards |
| `npm run contract` | unchanged from M5 (10/10 on the published release) |

## 7. Cleanup

`.m7-scratch/` (four profile homes, the suite, the run outputs) was deleted after the report was
written; `~/.dsh` was never a `DSH_HOME` and its `profiles` directory still holds only `node_modules`,
`rescue` and `web`.
