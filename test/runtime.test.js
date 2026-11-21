// The session runtime (docs/10 §4.2, §6, §12): the reducer is where an illegal fold transition
// becomes dead rather than a production surprise. These properties follow the style of
// test/invariants.test.js — a fixed seed, a generated sequence, and a failure message carrying the
// exact program — so a failing case is reproducible from the report alone.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isDeepStrictEqual } from 'node:util'

import fc from 'fast-check'

import {
  MAX_BACKOFF_BOUNDARIES,
  MAX_TASK_ATTEMPTS,
  createSessionRuntime,
  isBackingOff,
  reduce,
  skipReason,
  taskRuntime,
} from '../host/runtime/session-runtime.js'

/** @typedef {import('../host/runtime/session-runtime.js').Action} Action */
/** @typedef {import('../host/runtime/session-runtime.js').SessionRuntime} SessionRuntime */
/** @typedef {import('../host/runtime/session-runtime.js').TaskRuntime} TaskRuntime */

const TASK_IDS = ['T1', 'T2', 'T3']
const COMMIT_TYPES = /** @type {const} */ (['commit-folded', 'commit-busy', 'commit-deferred'])

// One fixed seed for every property, exactly as test/invariants.test.js does: a report is
// reproducible by re-running the suite on the same revision.
const SEED = 20261121

/**
 * A failure message that carries the seed and the generated program.
 *
 * @param {unknown} program
 */
function where(program) {
  return `\n  seed: ${SEED}\n  program: ${JSON.stringify(program)}`
}

/**
 * @param {number} [numRuns]
 */
function settings(numRuns = 200) {
  return { numRuns, seed: SEED, verbose: fc.VerbosityLevel.None }
}

/**
 * The reducer's input is typed as a discriminated union; fast-check generates the same shapes with
 * wider literal types, so the property casts at the call site.
 *
 * @param {unknown} action
 * @returns {Action}
 */
function asAction(action) {
  return /** @type {Action} */ (action)
}

/**
 * A deep copy of everything the runtime holds. Deep, not shallow: a reducer that mutated a pending
 * summary in place would otherwise leave the "before" snapshot pointing at the mutated object.
 *
 * @param {SessionRuntime} runtime
 */
function snapshotOf(runtime) {
  return structuredClone({
    generation: runtime.generation,
    boundary: runtime.boundary,
    busy: runtime.busy,
    tasks: runtime.tasks,
  })
}

const taskIdArb = fc.constantFrom(...TASK_IDS)
const epochArb = fc.integer({ min: 0, max: 6 })
const regionKeyArb = fc.string({ minLength: 1, maxLength: 6 })
const blocksArb = fc.array(fc.record({ type: fc.constant('text'), text: fc.string({ maxLength: 8 }) }), {
  maxLength: 2,
})
const usageArb = fc.record({ totalTokens: fc.nat({ max: 1000 }) })
const idSetArb = fc.uniqueArray(taskIdArb, { maxLength: 2 }).map((ids) => new Set(ids))

/**
 * One generated action. Every shape the reducer accepts is reachable, so the two whole-sequence
 * properties below exercise every branch rather than a hand-picked subset.
 */
const actionArb = fc.oneof(
  { weight: 2, arbitrary: fc.constant({ type: 'enter-pass' }) },
  { weight: 2, arbitrary: fc.constant({ type: 'leave-pass' }) },
  { weight: 3, arbitrary: fc.constant({ type: 'boundary++' }) },
  {
    weight: 4,
    arbitrary: fc.record({
      type: fc.constant('start-generation'),
      taskId: taskIdArb,
      epoch: epochArb,
      regionKey: regionKeyArb,
    }),
  },
  {
    weight: 5,
    arbitrary: fc.record({
      type: fc.constant('generation-finished'),
      taskId: taskIdArb,
      outcome: fc.constantFrom('ok', 'failed', 'cancelled'),
      blocks: blocksArb,
      usage: fc.option(usageArb, { nil: undefined }),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      type: fc.constantFrom(...COMMIT_TYPES),
      taskId: taskIdArb,
      epoch: fc.option(epochArb, { nil: undefined }),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({ type: fc.constant('drop-pending'), taskId: taskIdArb }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      type: fc.constant('skip'),
      taskId: taskIdArb,
      epoch: epochArb,
      reason: fc.string({ minLength: 1, maxLength: 8 }),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({ type: fc.constant('unsplit-skip'), taskId: taskIdArb, epoch: epochArb }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      type: fc.constant('retry'),
      taskId: taskIdArb,
      epoch: fc.option(epochArb, { nil: undefined }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ type: fc.constant('clear-retry'), taskId: taskIdArb }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      type: fc.constant('record-failure'),
      taskId: taskIdArb,
      recorded: fc.boolean(),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ type: fc.constant('claim-reject-log'), taskId: taskIdArb }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      type: fc.constant('prune-terminal'),
      waiting: idSetArb,
      terminal: idSetArb,
    }),
  },
)

// ---------------------------------------------------------------------------
// Purity, determinism and the boundary counter

test('the reducer never mutates its input and returns a new object only for a real change', () => {
  fc.assert(
    fc.property(fc.array(actionArb, { maxLength: 40 }), (actions) => {
      let runtime = createSessionRuntime()
      for (const action of actions) {
        const before = snapshotOf(runtime)
        const next = reduce(runtime, asAction(action))
        assert.deepEqual(
          snapshotOf(runtime),
          before,
          `reduce mutated its input on ${String(action.type)}${where(actions)}`,
        )
        const changed = !isDeepStrictEqual(before, snapshotOf(next))
        assert.equal(
          next === runtime,
          !changed,
          `identity disagreed with the state change on ${String(action.type)}${where(actions)}`,
        )
        // Same input, same answer: the reducer has no hidden input besides its arguments.
        assert.ok(
          isDeepStrictEqual(snapshotOf(reduce(runtime, asAction(action))), snapshotOf(next)),
          `reduce is not deterministic on ${String(action.type)}${where(actions)}`,
        )
        runtime = next
      }
    }),
    settings(),
  )
})

test('a boundary bump is monotone: the counter equals the number of bumps applied', () => {
  fc.assert(
    fc.property(fc.array(actionArb, { maxLength: 40 }), (actions) => {
      let runtime = createSessionRuntime()
      let bumps = 0
      for (const action of actions) {
        runtime = reduce(runtime, asAction(action))
        if (action.type === 'boundary++') bumps += 1
        assert.equal(
          runtime.boundary,
          bumps,
          `boundary was ${runtime.boundary} after ${bumps} bumps${where(actions)}`,
        )
      }
    }),
    settings(),
  )

  // A bump always allocates a new runtime with a larger number, and never goes backwards.
  let runtime = createSessionRuntime()
  for (let boundary = 1; boundary <= 5; boundary += 1) {
    const next = reduce(runtime, { type: 'boundary++' })
    assert.notEqual(next, runtime)
    assert.equal(next.boundary, boundary)
    runtime = next
  }
})

test('a pass is entered once and left once', () => {
  const idle = createSessionRuntime()
  const busy = reduce(idle, { type: 'enter-pass' })
  assert.equal(busy.busy, true)
  assert.notEqual(busy, idle)
  assert.equal(reduce(busy, { type: 'enter-pass' }), busy, 'a second entry is refused')

  const left = reduce(busy, { type: 'leave-pass' })
  assert.equal(left.busy, false)
  assert.equal(reduce(left, { type: 'leave-pass' }), left, 'a second leave is a no-op')
})

test('an unknown action is ignored instead of throwing', () => {
  const runtime = createSessionRuntime()
  assert.equal(reduce(runtime, /** @type {any} */ ({ type: 'not-an-action' })), runtime)
})

// ---------------------------------------------------------------------------
// Skips are epoch-scoped (docs/10 §4.1 and §12: the F9 fix)

test('a skip stops applying when the epoch moves', () => {
  fc.assert(
    fc.property(epochArb, fc.integer({ min: 1, max: 3 }), (epoch, delta) => {
      const later = epoch + delta
      const skipped = reduce(createSessionRuntime(), {
        type: 'skip',
        taskId: 'T1',
        epoch,
        reason: 'the span is unbalanced',
      })
      assert.equal(skipReason(taskRuntime(skipped, 'T1'), epoch), 'the span is unbalanced')
      assert.equal(skipReason(taskRuntime(skipped, 'T1'), later), undefined)

      // At the same epoch the skip still applies, so unsplitting it is a no-op.
      assert.equal(reduce(skipped, { type: 'unsplit-skip', taskId: 'T1', epoch }), skipped)

      const moved = reduce(skipped, { type: 'unsplit-skip', taskId: 'T1', epoch: later })
      assert.notEqual(moved, skipped, 'a moved epoch must drop the skip')
      const task = taskRuntime(moved, 'T1')
      assert.equal(task?.skip, null)
      assert.equal(task?.phase, 'waiting')
      assert.equal(skipReason(task, epoch), undefined, 'the old epoch no longer applies')
      assert.equal(skipReason(task, later), undefined, 'a cleared skip cannot apply to the new epoch')
      // The one-line explanation was already spent; a skip at the new epoch is refused, not logged
      // again, so the runner's log text and count stay the same as before the refactor.
      assert.equal(reduce(moved, { type: 'skip', taskId: 'T1', epoch: later, reason: 'again' }), moved)
    }),
    settings(),
  )
})

// ---------------------------------------------------------------------------
// The §12 failure table: transitions it forbids are dead

test('no illegal transition changes the state', () => {
  const base = createSessionRuntime()

  // A second generation while one is in flight.
  const generating = reduce(base, { type: 'start-generation', taskId: 'T1', epoch: 5, regionKey: 'k' })
  assert.equal(
    reduce(generating, { type: 'start-generation', taskId: 'T2', epoch: 5, regionKey: 'k2' }),
    generating,
  )

  // A commit for a task that has already folded.
  const folded = reduce(base, { type: 'commit-folded', taskId: 'T1', epoch: 5 })
  for (const type of COMMIT_TYPES) {
    assert.equal(reduce(folded, { type, taskId: 'T1', epoch: 5 }), folded, `${type} after a fold`)
  }

  // A skip older than the task's current phase.
  assert.equal(
    reduce(generating, { type: 'skip', taskId: 'T1', epoch: 4, reason: 'older than the phase' }),
    generating,
  )
  // A second skip for the same task, even at a newer epoch: explained once, never replaced.
  const skipped = reduce(base, { type: 'skip', taskId: 'T1', epoch: 5, reason: 'r' })
  assert.equal(reduce(skipped, { type: 'skip', taskId: 'T1', epoch: 6, reason: 'again' }), skipped)

  // A settlement for a task with no generation in flight.
  assert.equal(reduce(base, { type: 'generation-finished', taskId: 'T1', outcome: 'failed' }), base)
  assert.equal(
    reduce(skipped, { type: 'generation-finished', taskId: 'T1', outcome: 'ok', blocks: [] }),
    skipped,
  )

  // A retry while the previous backoff is still in force.
  const retried = reduce(base, { type: 'retry', taskId: 'T1', epoch: 1 })
  assert.equal(reduce(retried, { type: 'retry', taskId: 'T1', epoch: 1 }), retried)
})

test('a second generation in flight is refused', () => {
  fc.assert(
    fc.property(taskIdArb, epochArb, regionKeyArb, (taskId, epoch, regionKey) => {
      const started = reduce(createSessionRuntime(), {
        type: 'start-generation',
        taskId,
        epoch,
        regionKey,
      })
      assert.equal(started.generation?.taskId, taskId)
      assert.equal(started.generation?.epoch, epoch)
      assert.equal(taskRuntime(started, taskId)?.phase, 'generating')
      assert.equal(
        reduce(started, { type: 'start-generation', taskId: 'T2', epoch: epoch + 1, regionKey }),
        started,
        'a second generation in flight must be refused',
      )
      // A settlement for an unrelated task may not clear the one in flight.
      assert.equal(
        reduce(started, { type: 'generation-finished', taskId: 'T9', outcome: 'ok', blocks: [] }),
        started,
      )
      const finished = reduce(started, { type: 'generation-finished', taskId, outcome: 'cancelled' })
      assert.equal(finished.generation, null)
      assert.notEqual(
        reduce(finished, { type: 'start-generation', taskId: 'T2', epoch, regionKey }),
        finished,
        'once the generation ended, the next task may start one',
      )
    }),
    settings(),
  )
})

test('a commit after a fold is a no-op', () => {
  fc.assert(
    fc.property(taskIdArb, epochArb, (taskId, epoch) => {
      const folded = reduce(createSessionRuntime(), { type: 'commit-folded', taskId, epoch })
      assert.equal(taskRuntime(folded, taskId)?.phase, 'folded')
      for (const type of COMMIT_TYPES) {
        assert.equal(reduce(folded, { type, taskId, epoch }), folded, `${type} committed a folded task`)
      }
    }),
    settings(),
  )
})

test('the durable cap is terminal: an attempt after it is refused', () => {
  let runtime = createSessionRuntime()
  for (let attempt = 1; attempt <= MAX_TASK_ATTEMPTS; attempt += 1) {
    runtime = reduce(runtime, {
      type: 'start-generation',
      taskId: 'T1',
      epoch: attempt,
      regionKey: 'k',
    })
    runtime = reduce(runtime, { type: 'generation-finished', taskId: 'T1', outcome: 'failed' })
    assert.equal(taskRuntime(runtime, 'T1')?.failedGeneration, true, 'the record is owed')
    runtime = reduce(runtime, { type: 'record-failure', taskId: 'T1', recorded: true })
    const task = taskRuntime(runtime, 'T1')
    assert.equal(task?.attempts, attempt)
    assert.equal(task?.phase, attempt === MAX_TASK_ATTEMPTS ? 'failed' : 'waiting')
  }
  const terminal = taskRuntime(runtime, 'T1')
  assert.equal(terminal?.attempts, MAX_TASK_ATTEMPTS)
  // The cap is terminal: no further generation is accepted for the task.
  assert.equal(reduce(runtime, { type: 'start-generation', taskId: 'T1', epoch: 9, regionKey: 'k' }), runtime)
  assert.equal(reduce(runtime, { type: 'record-failure', taskId: 'T1', recorded: true }), runtime)
})

test('a cancelled generation does not move the durable count', () => {
  const started = reduce(createSessionRuntime(), {
    type: 'start-generation',
    taskId: 'T1',
    epoch: 2,
    regionKey: 'k',
  })
  const cancelled = reduce(started, { type: 'generation-finished', taskId: 'T1', outcome: 'cancelled' })
  const task = taskRuntime(cancelled, 'T1')
  assert.equal(task?.attempts, 0, 'a turn that produced nothing is not a failed attempt')
  assert.equal(task?.phase, 'cancelled')
  assert.equal(cancelled.generation, null)
})

// ---------------------------------------------------------------------------
// Generation results and pending summaries

test('a generated summary carries the region key the runner resolved', () => {
  fc.assert(
    fc.property(regionKeyArb, blocksArb, usageArb, (regionKey, blocks, usage) => {
      const started = reduce(createSessionRuntime(), {
        type: 'start-generation',
        taskId: 'T1',
        epoch: 2,
        regionKey,
      })
      const finished = reduce(started, {
        type: 'generation-finished',
        taskId: 'T1',
        outcome: 'ok',
        blocks,
        usage,
      })
      const task = taskRuntime(finished, 'T1')
      assert.equal(task?.pending?.regionKey, regionKey)
      assert.deepEqual(task?.pending?.blocks, blocks)
      assert.deepEqual(task?.pending?.usage, usage)
      assert.equal(task?.phase, 'waiting')
      assert.equal(finished.generation, null)

      const folded = reduce(finished, { type: 'commit-folded', taskId: 'T1', epoch: 3 })
      assert.equal(taskRuntime(folded, 'T1')?.pending, null, 'a fold consumes the pending summary')
      assert.equal(taskRuntime(folded, 'T1')?.phase, 'folded')
    }),
    settings(),
  )
})

test('drop-pending forgets a summary without folding the task', () => {
  const started = reduce(createSessionRuntime(), {
    type: 'start-generation',
    taskId: 'T1',
    epoch: 1,
    regionKey: 'k',
  })
  const finished = reduce(started, {
    type: 'generation-finished',
    taskId: 'T1',
    outcome: 'ok',
    blocks: [{ type: 'text', text: 'summary' }],
  })
  const dropped = reduce(finished, { type: 'drop-pending', taskId: 'T1' })
  assert.equal(taskRuntime(dropped, 'T1')?.pending, null)
  assert.equal(taskRuntime(dropped, 'T1')?.phase, 'waiting')
  assert.equal(reduce(dropped, { type: 'drop-pending', taskId: 'T1' }), dropped)
})

// ---------------------------------------------------------------------------
// Backoff, deferral and the one-line explanations

test('an unexpected failure backs off 1, 2, 4, 8 and then stays at the cap', () => {
  let runtime = createSessionRuntime()
  /** @type {number[]} */
  const delays = []
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const task = taskRuntime(runtime, 'T1')
    // The next attempt can only arrive after the announced boundary: skip the idle ones.
    while (task !== undefined && task.retryAfter !== null && runtime.boundary < task.retryAfter) {
      runtime = reduce(runtime, { type: 'boundary++' })
    }
    const before = runtime.boundary
    const retried = reduce(runtime, { type: 'retry', taskId: 'T1', epoch: 1 })
    const next = taskRuntime(retried, 'T1')
    const delay = Math.min(2 ** (attempt - 1), MAX_BACKOFF_BOUNDARIES)
    assert.equal(next?.retries, attempt)
    assert.equal(next?.retryAfter, before + delay)
    delays.push(delay)
    assert.equal(isBackingOff(next, retried.boundary), true)
    // A second attempt during the wait is refused.
    assert.equal(reduce(retried, { type: 'retry', taskId: 'T1', epoch: 1 }), retried)
    runtime = retried
  }
  assert.deepEqual(delays.slice(0, 6), [1, 2, 4, 8, 8, 8])
})

test('clear-retry ends a backoff without touching the durable count', () => {
  const retried = reduce(createSessionRuntime(), { type: 'retry', taskId: 'T1', epoch: 1 })
  assert.equal(isBackingOff(taskRuntime(retried, 'T1'), retried.boundary), true)
  const cleared = reduce(retried, { type: 'clear-retry', taskId: 'T1' })
  assert.equal(isBackingOff(taskRuntime(cleared, 'T1'), cleared.boundary), false)
  assert.equal(taskRuntime(cleared, 'T1')?.retries, 0)
  assert.equal(taskRuntime(cleared, 'T1')?.retryAfter, null)
  assert.equal(taskRuntime(cleared, 'T1')?.attempts, 0)
  assert.equal(reduce(cleared, { type: 'clear-retry', taskId: 'T1' }), cleared)
})

test('a deferral records the epoch it was decided at', () => {
  const deferred = reduce(createSessionRuntime(), { type: 'commit-deferred', taskId: 'T1', epoch: 4 })
  assert.equal(taskRuntime(deferred, 'T1')?.epoch, 4)
  assert.equal(taskRuntime(deferred, 'T1')?.phase, 'waiting')
  assert.equal(reduce(deferred, { type: 'commit-deferred', taskId: 'T1', epoch: 4 }), deferred)
})

test('the one-line explanations are claimed once per task', () => {
  const base = createSessionRuntime()

  const busy = reduce(base, { type: 'commit-busy', taskId: 'T1', epoch: 1 })
  assert.equal(taskRuntime(busy, 'T1')?.waitLogged, true)
  assert.equal(reduce(busy, { type: 'commit-busy', taskId: 'T1', epoch: 2 }), busy, 'one wait line')

  const rejected = reduce(base, { type: 'claim-reject-log', taskId: 'T1' })
  assert.equal(taskRuntime(rejected, 'T1')?.rejectLogged, true)
  assert.equal(reduce(rejected, { type: 'claim-reject-log', taskId: 'T1' }), rejected)
})

// ---------------------------------------------------------------------------
// Pruning terminal tasks

test('prune-terminal forgets terminal tasks and pending text that can no longer fold', () => {
  let runtime = createSessionRuntime()
  runtime = reduce(runtime, { type: 'skip', taskId: 'T1', epoch: 0, reason: 'r' })
  runtime = reduce(runtime, { type: 'retry', taskId: 'T2', epoch: 0 })
  runtime = reduce(runtime, { type: 'start-generation', taskId: 'T3', epoch: 1, regionKey: 'k' })
  runtime = reduce(runtime, {
    type: 'generation-finished',
    taskId: 'T3',
    outcome: 'ok',
    blocks: [{ type: 'text', text: 'summary' }],
  })

  // Nothing is terminal yet: a prune that still calls T2 waiting and T3 waiting keeps them.
  const kept = reduce(runtime, {
    type: 'prune-terminal',
    waiting: new Set(['T2', 'T3']),
    terminal: new Set(),
  })
  assert.equal(kept, runtime)

  const pruned = reduce(runtime, {
    type: 'prune-terminal',
    waiting: new Set(['T2']),
    terminal: new Set(['T1', 'T3']),
  })
  assert.equal(taskRuntime(pruned, 'T1'), undefined)
  assert.equal(taskRuntime(pruned, 'T3'), undefined)
  assert.equal(taskRuntime(pruned, 'T2')?.retryAfter, 1, 'a waiting task keeps its backoff')
  assert.equal(
    reduce(pruned, {
      type: 'prune-terminal',
      waiting: new Set(['T2']),
      terminal: new Set(['T1', 'T3']),
    }),
    pruned,
    'a second prune of the same state changes nothing',
  )

  // A task the projection no longer calls waiting, but not terminal, keeps its entry and loses the
  // dead pending text.
  const cleared = reduce(runtime, {
    type: 'prune-terminal',
    waiting: new Set(),
    terminal: new Set(),
  })
  assert.equal(taskRuntime(cleared, 'T3')?.pending, null)
  assert.equal(taskRuntime(cleared, 'T3')?.phase, 'waiting')
})
