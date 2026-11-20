# 0001 — Write a new plugin instead of forking taskfold

**Status:** Accepted (2026-11-20)

## Context

taskfold v0.40.1 implements the task-folding idea and has real users and measurements. Its problems ([01-background.md](../01-background.md)) concentrate in three foundations: text-encoded state, message anchors, and an internal-class subclass. Its test suite (246 tests) encodes many real log shapes but also the old protocol's rules.

## Options

1. **Fork and refactor incrementally.** Keeps compatibility with existing sessions. But each foundation change touches the reducer, planner, tools and prompt at once; intermediate states would need both protocols.
2. **Rewrite, reusing ideas and test scenarios, not code.**

## Decision

Option 2. Reuse: the concept, the fold floor derivation, the prefix-anchored delegate request, constructed titles, the numbered span index, recall by `shadowedSeqs`, the dock. Port test *scenarios* (relays, nesting, auto compaction mid-task, resume) into the new fixture DSL.

## Consequences

- No compatibility with taskfold sessions: old folds remain ordinary `compaction/summary` events and stay visible to `fold_recall`; old open marks are ignored.
- The two plugins cannot be installed together (same tool names); the plugin detects this and stays inactive.
- New package name `dsh-task-folding`; license MIT.
