# 0008 — The host is reached through ports, and the shim is one of them

**Status:** Accepted (2026-11-21). Supersedes the "one adapter" wording of [0004](0004-engine-adapter.md),
keeping its decision to fold through the host's own transaction.

## Context

ADR 0004 put everything that touches the host's compaction internals into one file and called it an
adapter. In practice that file also held fold logic, and three other host boundaries stayed outside
any named module: the logger (assumed infallible — T3 found a throwing sink replacing the original
error and rejecting the hook), the clock (`Date.now()` read in two places), and the service lookups
(`ctx.get(...)` spread through the mount path, where a missing projection service threw a `TypeError`
half-way through registration — T1).

The plugin also pays for three missing host contracts: a way to fold prepared blocks, a marker for who
wrote a summary, and a framing field for a mid-history checkpoint. Each is a place where a future host
version may offer an API; if the plugin's calls are scattered, adopting it is a rewrite.

## Options

1. Keep the single adapter and add the other boundaries to it. Simple, but the file becomes the one
   place where every host assumption lives and no guarantee is named.
2. **Ports with written guarantees**: `CompactionPort` (fold/reject/classify), `LlmPort`,
   `LogPort` ("never throws"), `ClockPort`, and `HostServices` (the only module calling `ctx.get`).
   The compaction port has a shim implementation today and a native stub for the day the host exposes
   the API; the shim is the only file that imports `@deepseek-ai/dsh-compaction-basic`.
3. Wrap the host services (`ctx.compaction`, `ctx.llm`) to add the missing behaviour. Rejected by
   hard constraint 7: wrapping a host service is a global side effect on other plugins.

## Decision

Option 2, with `host/ports/compaction-shim.js` as the single point of internals and
`host/ports/compaction-native.js` as a documented stub that throws if anyone selects it before the API
exists. `host/engine-adapter.js` is deleted; callers use `CompactionPort.fold(FoldRequest)` with an
object, so a field added later (as `usage` was) is a compatible change.

## Consequences

- Every host assumption has one owner and one guarantee; a missing service deactivates the plugin
  cleanly instead of throwing mid-registration.
- A future host API is a new implementation of the port, not a revision of this ADR.
- Requests are objects: `FoldRequest { agent, region, blocks, route, usage?, signal? }` and
  `RejectRequest`; `SummaryResult` carries `usage` and our own `source: 'self' | 'delegate'`.
- `AGENTS.md` constraint 6 names the shim, so the boundary is enforced by review rather than habit.
- The port grew a `reset` hook so tests keep the process-wide caching they relied on; that hook is the
  only test-shaped seam in production code.
