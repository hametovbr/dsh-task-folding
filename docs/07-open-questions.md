# 07 — Open questions

Each question names the assumption the design makes today, why it matters, and how to settle it. Most are settled in milestone M0 ([05](05-implementation-plan.md#m0--host-verification-spike-no-plugin-code)). Record answers here, with the host version, and update the affected documents.

<a id="q1"></a>
## Q1 — PTC (`run_code`) calls

**Assumption:** task tools called from inside a `run_code` program produce no `tool/result` event of their own (they are recorded in `tool/ptc-dispatch`), so batch tracking cannot see them. The tools refuse when `exec.rootCallId` is set.
**Why it matters:** a silently ignored begin/end would corrupt the stack.
**Settle:** M0 task 3. Also check whether a tool can opt out of the PTC SDK entirely (not found in `packages/core/tools/src/contracts.ts`); if it can, prefer that over refusal.

<a id="q2"></a>
## Q2 — `meta` durability

**Assumption:** `output.presentationMeta` output is persisted as `tool/result.data.meta`, survives restart and session-format migrations, and reaches projections on replay.
**Why it matters:** it is the plugin's only durable write channel.
**Settle:** M0 task 1, plus a check of the session-format migration packages for how they treat `meta`.

<a id="q3"></a>
## Q3 — Idle scheduling for delegate folds

**Assumption:** calling `agent.whenIdle().then(() => agent.runMaintenance(job))` from `agent/turn-stopping` (without awaiting) runs `job` once the agent is idle; user input arriving meanwhile waits in the inbox until the job settles; `runMaintenance` throws synchronously if a turn already started.
**Why it matters:** decides whether delegate folds can stay off the critical path.
**Settle:** M0 task 4. Fallback: run delegate folds inside `agent/turn-stopping` (delays idling, never a step).

<a id="q4"></a>
## Q4 — Resolving host packages from a profile bundle

**Assumption:** `@deepseek-ai/dsh-compaction-basic`, `@deepseek-ai/dsh-llm` and `@deepseek-ai/schemastery` may not be resolvable with a bare `import` from a profile-installed bundle (taskfold needed path probing and `createRequire`).
**Why it matters:** decides how much probing `engine-adapter.js` and `settings.js` need.
**Settle:** M0 task 6. Also check whether declaring them as `peerDependencies` makes `dsh plugin add` link them.

<a id="q5"></a>
## Q5 — Checkpoint framing for mid-history folds

**Assumption:** the host frames every summary with a preamble written for head-of-history checkpoints ("…Continue the task directly from the messages that follow…"). For a fold in the middle of history this is slightly misleading but harmless.
**Why it matters:** wording that confuses the model costs quality; the preamble also costs ~60 tokens per fold.
**Settle:** evaluate in M7; include an option to override framing in the upstream proposal (M8).

<a id="q6"></a>
## Q6 — Deferred loading of `fold_recall`

**Assumption:** `deferLoading: true` would save ~210 tokens per request, at the cost of a lookup when the model first needs recall.
**Settle:** M7, measure recall frequency and first-use behavior with and without deferral.

<a id="q7"></a>
## Q7 — One Loader row for Host + Client, and the dock slot

**Assumption:** following the official `templates/decoration`, one row named after the package can carry both the Host `apply` and the Client module; the dock slot is `conversation.composer.dock` or `conversation.input.dock`.
**Settle:** M0 task 5 with `cordis_inspect` (`Slots.listSubTree`).

<a id="q8"></a>
## Q8 — Replacement events in projections

**Assumption:** every surface replacement (compaction checkpoint `user/message`, pruner `tool/result`) reaches projection `apply` with top-level `surfaceOp: { op: 'replace', startSeq, endSeq }` and a complete `sourceEventSeqs`, as `packages/core/session/src/types.ts` documents.
**Why it matters:** cut translation depends on it entirely.
**Settle:** M0 task 2. Fallback: derive shadowed sets from `compaction/summary.data.shadowedSeqs` and `compaction/prune.data.shadowedSeqs`, which immediately precede their replacement events by contract.

<a id="q9"></a>
## Q9 — Concurrent tool execution within a batch

**Assumption:** calls of one assistant message may execute concurrently, so two `task_begin`s in one batch can read the same `nextId`; an in-memory per-session reservation prevents duplicate ids.
**Settle:** read `packages/core/tool-executor-native` scheduling; keep the reservation regardless (cheap).

<a id="q10"></a>
## Q10 — Implicit per-turn task

**Open design question:** should a turn that ends with no open task and a span above the floor be folded automatically (delegate path, next idle)? It would cover models that ignore the discipline, at the cost of folding work the model may still want verbatim.
**Settle:** after M7 data on how often tasks are skipped; ship off by default if added.
