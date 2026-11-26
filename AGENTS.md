# Working in this repository

Instructions for anyone — human or coding agent — implementing dsh-task-folding.

## Ground rules

- **English only.** Code, comments, commit messages, documentation, locale files and every model-facing text.
- **The design lives in `docs/`.** Read `docs/README.md`, then `docs/03-architecture.md` and the milestone you are working on in `docs/05-implementation-plan.md`. If the code must differ from the design, update the design in the same commit and, for a real decision, add an ADR in `docs/adr/`.
- **Host facts come from `docs/02-host-api.md`.** Before using any DeepSeek Harness API not listed there, verify it in the host source (`deepseek-ai/deepseek-harness`) and add it to that file with its source location.
- **Work milestone by milestone.** Do not start a milestone before the previous one meets its acceptance criteria.

## Hard constraints (from the architecture)

1. Never append session events. The only durable write channel is `output.presentationMeta` → `tool/result.data.meta`.
2. Never parse model-facing text to derive state.
3. `host/domain/` is pure: no `ctx`, no I/O, no `Date.now()`, no randomness. In particular
   `host/domain/projection.js` and `host/domain/cuts.js` are enforced by an ESLint block.
4. No code on the `agent/pre-step` or `agent/turn-stopping` path calls `session.snapshotEvents()` or iterates the event log.
5. Never await an LLM call inside `agent/pre-step` or `agent/turn-stopping`; delegate summaries are generated in an un-awaited background promise (see `docs/adr/0006-background-delegate.md`).
6. Only `host/ports/compaction-shim.js` may import, resolve or reference `@deepseek-ai/dsh-compaction-basic` internals; `host/ports/compaction.js` is the port every caller uses.
7. Never wrap or monkey-patch host services (`ctx.llm`, `ctx.compaction`, …).
8. Never write files to disk at runtime.
9. All model-facing strings live in `host/domain/texts.js`; `host/prompt/section.js` only
   assembles the registration, and the prompt budget test must pass.

## Code style

- ES modules, `.js`, JSDoc types checked with `tsc --noEmit --checkJs`.
- Small pure functions; comments explain *why*, not history. Bug history belongs in commit messages, not in comments.
- No runtime dependencies. Dev dependencies are fine.

## Commands

```sh
npm test            # node:test, all unit/property/replay/component/degradation/fault tests
npm run coverage    # tests + the gate for every host/**/*.js (>=90% lines, >=85% branches, >=80% functions)
npm run typecheck   # tsc --noEmit --checkJs
npm run lint        # eslint + prettier --check
npm run pack:check  # manifest and tarball contract (offline)
npm run mutation    # single-operator mutations of the pure modules, score >= 85%
npm run perf        # wall-clock guards, kept out of `npm test`
npm run e2e         # headless E2E: a scripted session in a scratch DSH home (needs an API key)
npm run release:check  # every release gate at once; `npm publish` runs it from prepublishOnly
npm run locale:gen  # regenerate client/client.locale.generated.js from locale/en.json
```

## Commits

- One logical change per commit; imperative subject line ≤ 72 characters.
- Tests and docs in the same commit as the behavior they cover.
