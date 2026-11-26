// Tests for scripts/release-check.js (the `prepublishOnly` gate): the argument parser and the gate
// plan. The gates themselves are the scripts `npm test` and CI already run, so what needs pinning is
// that the plan includes them — an offline build must skip exactly the two that need the network and
// the model key, and nothing else.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseArgs, plan, USAGE } from '../scripts/release-check.js'

test('the default plan runs the static gates, then the contract and the live E2E', () => {
  const steps = plan({ staticOnly: false, full: false }).map((step) => step.script)
  assert.deepEqual(steps, ['lint', 'typecheck', 'test', 'coverage', 'perf', 'pack:check', 'contract', 'e2e'])
})

test('--static drops exactly the two gates that need the network and a key', () => {
  const steps = plan({ staticOnly: true, full: false }).map((step) => step.script)
  assert.deepEqual(steps, ['lint', 'typecheck', 'test', 'coverage', 'perf', 'pack:check'])
  for (const name of ['contract', 'e2e', 'mutation']) assert.ok(!steps.includes(name), name)
})

test('--full appends the mutation run last, because it takes an hour', () => {
  const steps = plan({ staticOnly: false, full: true }).map((step) => step.script)
  assert.equal(steps.at(-1), 'mutation')
  assert.equal(steps.length, 9)
})

test('every step names the npm script and why a failure matters', () => {
  for (const step of plan({ staticOnly: false, full: true })) {
    assert.ok(step.script.length > 0)
    assert.ok(step.why.length > 10, `${step.script}: ${step.why}`)
  }
})

test('parseArgs reads the flags and defaults to the full gate', () => {
  assert.deepEqual(parseArgs([]), { staticOnly: false, full: false, help: false })
  assert.deepEqual(parseArgs(['--static']), { staticOnly: true, full: false, help: false })
  assert.deepEqual(parseArgs(['--full']), { staticOnly: false, full: true, help: false })
  assert.deepEqual(parseArgs(['--help']), { staticOnly: false, full: false, help: true })
  assert.deepEqual(parseArgs(['-h']), { staticOnly: false, full: false, help: true })
})

test('parseArgs refuses an unknown flag and the contradictory pair', () => {
  assert.throws(() => parseArgs(['--network']), /unknown argument: --network/)
  assert.throws(() => parseArgs(['--static', '--full']), /mutually exclusive/)
})

test('the usage text names both escape hatches', () => {
  assert.ok(USAGE.includes('--static'))
  assert.ok(USAGE.includes('--full'))
  assert.ok(USAGE.includes('npm run mutation'))
})
