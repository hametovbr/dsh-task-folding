# 09 — Test strategy and plan

Status: proposed 2026-11-21 (after M7). This file is the plan; `docs/06-testing.md` stays the record of
what the suite actually does today.

## 1. Why the current shape is not enough

231 tests and a 100 % gate on two modules look stronger than they are. Every real defect this project
has shipped was invisible to the existing suite:

| Defect (milestone) | Which test would have caught it | Which layer that is |
|---|---|---|
| Region key included the surface length, so every generated summary was discarded (M5) | a property over the region key: appending a node after the region must not change it | invariants (P1) |
| `exports["./client"]` pointed at a missing file, so the whole client module vanished silently (M6) | "every declared export path exists" plus a browser boot check | manifest contract (P0) + E2E (P4) |
| Provider usage was not forwarded, so the cache audit could not see plugin folds (M5) | "a fold summary carries usage" | component (P2) |
| `deferLoading` hid `fold_recall` from the model (M7) | a live behavioural check, not a unit test | E2E (P4) |
| `scripts/contract-check.js` failed in a clean checkout (`ENOENT .tmp`) (M2) | running the contract job in a fresh clone | environment matrix (P3) |

The pattern: the bugs lived in the seams between modules, in the host's real behaviour, and in
degradations — not in pure functions. The suite is strong exactly where the code is pure.

## 2. Approach

Risk-oriented pyramid with four mandatory pillars and two amplifiers. Each layer exists to catch a class
of defect the layer below cannot.

### P1 — Invariants, not examples

`fast-check` is already a dev dependency; use it for the properties the system promises rather than more
hand-written cases:

- cuts are monotone and never move backwards on append;
- `apply` is deterministic and idempotent (replaying the same prefix twice yields the same state);
- every `state.tasks` entry is reachable from `state.open`/`state.order` and vice versa;
- `surfaceOp.replace` translates every task's cuts exactly once (no double shift, no lost task);
- a fold's `shadowedSeqs` is a subset of the region it replaced;
- the region key is a function of the region's nodes only;
- `estTokens` never increases when a node is replaced by a summary.

### P2 — Degradation first

The plugin mounts into any profile, so "the service is missing" is a supported mode, not an edge case:
no compaction engine, no `llm`, no tool sink, a malformed `meta`, an unknown `stateVersion`, a session
whose log was written by an older realm. Each must have a defined, tested behaviour — for most of them:
the tools keep working, folding is off, one log line, no throw.

### P3 — Golden journals

Every live scenario becomes a fixture (M2, M3, M5, M6 have them) and is replayed against expected states.
This is the only layer that catches a host format change, and it is cheap: add a fixture per milestone and
per host release.

### P4 — Fault injection at the seams

The seams already exist (`stateOf`, `engine`, `delegate`, `logger`, clock): throw from each one, abort the
signal mid-fold, hold the compaction lock, deliver a generation whose region moved, resolve `null`,
reject twice, and check that the runner keeps its promises (no throw out of the hot path, no unhandled
rejection, one durable record per failure).

### P5 — Live checks with machine assertions

Runs against a real DSH must assert, not be read by eye: a headless script that opens a task, folds it,
recalls it, and checks the journal (`verify-cache`, `eval-report`) — plus a browser check of the dock and
the settings card, which is the only way to close F7 and to prove the client module is in the boot graph.

### Amplifiers

- **Mutation testing** on `projection.js`, `cuts.js` and `planner.js`: 100 % line coverage is not quality;
  a surviving mutant is a missing assertion. Target: ≥ 85 % killed.
- **Coverage where the risk is**, not only where it is easy: extend the gate to every `host/**/*.js`
  (≥ 90 % lines, ≥ 85 % branches), keeping 100 % on the two pure modules.

## 3. Plan

| Phase | Work | Deliverable | Exit criterion | Effort |
|---|---|---|---|---|
| **T0** | Manifest + environment contract: every `exports` path exists, `dsh.client` shape, `files` covers what is documented, the pack installs into an empty profile | `test/manifest.test.js`, `scripts/check-pack.js` (`npm run pack:check`) — **done** | fails on any broken path or missing file in the tarball | 0.5 d |
| **T1** | Degradation suite: engine missing, `llm` missing, no tool sink, malformed `meta`, unknown `stateVersion`, foreign-realm log — **done 2026-11-21** | `test/degradation.test.js` (14 tests, 0 skipped) | each case has an asserted behaviour and a single log line; none throws | 1 d |
| **T2** | Property suite (P1 list) over generated event streams (append, replace, prune, compaction, task tool calls) — **done 2026-11-21** | `test/invariants.test.js` (9 tests, 8 properties × 200 + a non-vacuity guard, 1740 generated streams, seed 20261121, ~4 s) | 8 properties × ≥ 200 cases each, deterministic with a fixed seed, one failing seed reproducible from the report | 2 d |
| **T3** | Fault injection in the runner and adapter (P4 list) — **done 2026-11-21**; the suite found two real hot-path defects, both fixed: a throwing logger replaced the original error and rejected the hook, and an aborted generation counted toward the durable cap | `test/faults.test.js` (12 tests, 0 skipped) | every seam has a throw/abort/lock case; no unhandled rejection; durable records counted | 1.5 d |
| **T4** | Coverage gate extended to `host/**/*.js` + mutation run on the three pure modules — **done 2026-11-21** (gate is now `host/**/*.js` at ≥ 90 % lines / ≥ 85 % branches / ≥ 80 % functions: the suite reaches 99.85 / 94.86 / 98.32; `scripts/mutate.js` + `npm run mutation`, no dependency) | CI change, `scripts/mutate.js` | gate green; mutation score ≥ 85 %; report committed under `docs/` | 1.5 d |
| **T5** | Headless E2E: `npm run e2e` runs a scripted session (task → fold → recall) against a scratch profile and asserts the journal with the existing scripts — **done 2026-11-26**: two scenarios (`self`, `delegate`), one process per turn, 22 and 23 named checks over the turn stream and the journal, the cache-hit gate among them; `--plugin dsh-task-folding@<version>` checks a published release | `scripts/e2e-headless.js`, `.github/workflows/e2e.yml` (nightly), `test/e2e-headless.test.js` (16 tests), two golden journals | green on the published release; a broken fold fails it — every check is proven to fail by a mutation in the test | 1.5 d |
| **T6** | Browser E2E: the dock renders, `showTaskBar` hides it, the settings card writes and the value survives a restart (F7) — **done 2026-11-22**: `scripts/e2e-browser.js` drives the running web app through the ego runtime and asserts the client boot graph, the card, the on/off writes against the profile patch on disk, the live dock and a reload; restart persistence was checked by hand against the same patch | `scripts/e2e-browser.js` (ego), nightly | ten assertions pass; F7 closed as environment | 1.5 d |
| **T7** | Load and longevity: 200 folds in one session, 5 000 tasks, pass latency p95, prompt budget under every settings combination | `test/load.manual.js` (like `perf.manual.js`) | p95 pass < 10 ms, memory growth < 50 MB, budget ≤ 3 400 chars in all 32 combinations | 1.5 d |
| **T8** | Host-version matrix: contract check against three releases (current, previous, latest) plus one golden journal per release | matrix in `.github/workflows/contract.yml` | the matrix passes, or the failure names the release and the field that moved | 1 d |

Total ≈ 12 engineer-days, of which T0–T4 (~6.5 d) is the part that raises confidence most per day: they
are deterministic, run on every commit, and target exactly the classes that have bitten us.

**T5 result (2026-11-26).** The script walks the whole chain a user gets: it creates a scratch DSH home
from the shipped `headless` template, adds the plugin with `dsh plugin add`, copies the credentials file
(or uses `DEEPSEEK_API_KEY` and leaves the managed store off, as CI does), and drives one `dsh` process
per turn with `--session-id`. `self` and `delegate` are separate profiles because the fold path is chosen
by settings: the delegate profile sets `minSummaryChars: 3000`, so the model's ~750-character summary is
below the floor and the verdict is `delegate` by configuration rather than by the model's cooperation.
Live: 22/22 and 23/23 named checks, three turns each, ≈ 1 minute per scenario and ≈ 300k billed tokens
for the pair. The spans were 6,690 and 6,862 tokens; the delegate fold made one request with 19,072
cached against 255 fresh input tokens — 98.7 % against a 98.6 % median main request. The keepalive turn
is `sleep 12` in `bash`: a generated summary needs a turn long enough to finish inside, and a shorter
turn kills the background generation when its process exits. Both sessions are committed as golden
journals and replayed by `test/e2e-headless.test.js`. The release form of the exit criterion is
`npm run e2e -- --plugin dsh-task-folding@<version>` against the published package; it cannot run before
the first publish (M7 §5), so the nightly today checks the working tree.

## 4. Order and dependencies

T0 → T1 → T2 → T3 can run in parallel after T0 (different files, no shared fixtures); T4 needs T2/T3 to
have assertions worth mutating; T5/T6 need the scratch-profile recipe that M6/M7 already document; T7
reuses `perf.manual.js`; T8 is independent and can start any time.

Gate policy: T0–T4 run in `npm test` and block a merge; T5/T6 run nightly and block a release; T7/T8 run
nightly and block a release that changes defaults or the host range.

## 5. What this plan deliberately does not do

- No mocking of host services: the seams are the contract, and a mock of `ctx.compaction` would test the
  mock. Where the host's real behaviour matters (deferring, framing, cache prefix), the check is live.
- No screenshot-diffing of the dock: it is host chrome, it changes for reasons outside this repo, and a
  pixel gate would fail for the wrong reason. The browser check asserts DOM state, not pixels.
- No full evaluation suite in CI: 120–240 model sessions per run is a budget decision, not a test. It
  stays a scheduled, owner-approved run (07 M7 report).
- No coverage number as a goal: the gate forbids regressions, the mutation score says whether the tests
  can fail at all.
