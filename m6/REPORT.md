# M6 — Hints and the dock: acceptance report

Date: 2026-11-21. Scope: milestone M6 ([`docs/05-implementation-plan.md`](../docs/05-implementation-plan.md) §3).

## 1. Environment

| Fact | Value |
|---|---|
| dsh | 0.2.2-rc.5 (`~/.dsh/runtime`) |
| Browser | ego-browser (Chromium) against a scratch web profile |
| Scratch Harness home | `<repo>/.m6-scratch/dsh-home` (deleted after the runs) |
| Profiles | `m6` (base + headless + plugin) for the hints; `m6-web` (base + web-app + plugin + the M0 probe as a control) for the dock |
| Mode | the web app served on `127.0.0.1`, token in the query, loopback = local mode |

## 2. What was built

| File | Content |
|---|---|
| `host/hints.js` (new) | `maybeHint(state, settings)` → `{ key, message } | null`, `bucketFor`, `hintKeyFor`; pure, only imports the projection's `HINT_SOURCE_KIND` and `texts` |
| `host/texts.js` | `renderStaleTaskHint(id, title, bucket)` — the docs/04 §5 sentence, one line, byte-stable per bucket |
| `host/index.js` | the `agent/pre-step` handler appends the hint message to the host's own decision (with a stable `id`, which the host's durable-message check requires) |
| `client/client.js` (new) | the browser module: the dock in `conversation.input.dock` and a configuration card in `plugins.bundle.config` |
| `locale/en.json` | 22 `client.*` keys for the dock and the card |
| `package.json` | `exports["./client"]`, `files: ["client", …]`, `dsh.client` (`platform: web`, `immediately`, `inject: [dsh-client-ui-conversation]`) |

## 3. Hints — live

Profile `m6` with `staleTaskSteps: 5` (the schema minimum) and a task kept open across several
headless runs (each run is a new process, so this also tests durability):

```
assistant messages: 12
hint keys: T1:5, T1:10
projection: assistantCount 12, hintKey T1:10
```

- The first hint fired once, when the age reached 5, and **never again** across the following
  restarts — the latch lives in the log (`state.hintKey`), not in memory.
- At age 10 the next bucket published the second hint; the 25/50/100 numbers of the design are what
  this rule produces at the default threshold 25.
- The message the model saw: `Task T1 "long running" has been open for 5+ steps. If it is finished,
  call task_end with a summary; if it has distinct parts, wrap the remaining parts in nested tasks.`

Fixture: `test/fixtures/logs/m6-hints.jsonl`, replayed by `test/m6-journals.test.js`.

## 4. Dock — live in the browser

Scratch web profile, `http://127.0.0.1:<port>/?token=…`, an existing session with one open task:

- with `config.showTaskBar: true` the dock renders and reads the wire view:
  ![The dock above the composer](dock-live.png)
  (`T1 · long running`, one line, host theme colours);
- with `config.showTaskBar: false` after a restart the dock **does not render at all**, while the M0
  probe decoration in the same slot stays visible — so the setting is read and honoured, not the slot
  being empty;
- the plug-in's client module appears in the page's boot graph (`dsh-task-folding` among the 77 client
  entries) and registers both slots.

### The reason the dock did not appear at first — a real defect

`package.json` declared `"./client": "./client.js"`, but the file lives at `client/client.js`. The
host resolves that path and, when it is missing, drops the module from the client roster **silently**:
the page loads, the slot stays empty, no error anywhere. The export now points at
`./client/client.js`, and `test/client.test.js` asserts that the declared path is an existing file, so
this class of typo cannot come back unnoticed.

## 5. Configuration card — rendered, write not verified

The card renders in the plugin's page (`[data-task-folding-settings]`) with all eight fields and the
host's current values (2000, true, 200, 0.5, 25, true, `''`, `''`) plus the field descriptions.

**Writing from the card could not be confirmed in this environment, and the reason is not this
plugin:** toggling our checkbox changed the control but left `cordis.patch.yml` untouched; as a
control, changing the built-in `Subagent` depth from 1 to 2 through its own settings page left the
patch untouched as well. Either the scratch profile does not accept settings writes (its composition
comes from `--from-default-profile` plus a hand-written patch, and the settings service may have no
writable layer here), or the write lands in a store this check does not inspect. Recorded as **F7**
in [`docs/08-followups.md`](../docs/08-followups.md); the dock's reading of `showTaskBar` is proven
independently by the restart test above.

## 6. Tests and gates

| Gate | Result |
|---|---|
| `npm test` | 216 tests (195 at M5), all pass |
| `npm run coverage` | 100 % branch/line/function for `host/projection.js` and `host/cuts.js` |
| `npm run typecheck`, `npm run lint` | clean |
| `npm run perf` | 4 guards |

New tests: `test/hints.test.js` (13: buckets at the default and scaled thresholds, innermost task,
message shape and `source`, latch, byte stability, purity), `test/client.test.js` (4: loader form and
slot registrations, locale keys packaged and used, manifest paths resolve, no literal colours),
`test/m6-journals.test.js` (2: the live hint session, the latch after a restart), `test/plugin.test.js`
(+2: the pre-step handler appends one hint, and only once per key).

## 7. Deviations and doc changes

1. **Buckets scale with the setting** (`staleTaskSteps`, 2×, 4×) instead of being fixed at 25/50/100.
   The design pinned both the configurable threshold and the literal numbers; at any threshold other
   than 25 those disagree. Scaling keeps the text truthful and reproduces 25/50/100 at the default.
   → `docs/03` §8 and §10 updated.
2. **The hint goes through the pre-step decision, not `agent.inject`.** `docs/02` §5 said the opposite
   for hints; it now says why this plugin does not use `inject` (one logged `user/message` with a
   `source` the projection can latch on).
3. **The client export path bug** (§4) — one-line fix plus a test that the declared path exists.
4. **F7** — settings writes from the UI are unverified here; recorded in `docs/08`.

## 8. Cleanup

`.m6-scratch/` (both profiles, the control probe install, the sessions) was deleted; `~/.dsh` was
never written — its `profiles` directory still holds only `node_modules`, `rescue` and `web`.

Stopping here: M7 (evaluation and release) is not started.
