// The host ports (docs/10 §7): the logger's "never throws" guarantee, the clock seam, and the native
// compaction stub that must stand in for the public API the host does not have yet.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createClock } from '../host/ports/clock.js'
import { createLogPort } from '../host/ports/logger.js'
import { NativeCompactionPort } from '../host/ports/compaction-native.js'

test('a throwing logger never reaches the caller', () => {
  /** @type {string[]} */
  const attempted = []
  const port = createLogPort({
    /** @param {string} message */
    warn(message) {
      attempted.push(message)
      throw new Error('the sink is down')
    },
    /** @param {string} message */
    info(message) {
      attempted.push(message)
      throw new Error('the sink is down')
    },
    /** @param {string} message */
    error(message) {
      attempted.push(message)
      throw new Error('the sink is down')
    },
  })
  assert.doesNotThrow(() => port.warn('w'))
  assert.doesNotThrow(() => port.info('i'))
  assert.doesNotThrow(() => port.error('e'))
  assert.deepEqual(attempted, ['w', 'i', 'e'], 'every level was reached before it failed')
})

test('a logger without a level, or without a logger at all, is a no-op', () => {
  const partial = createLogPort({ warn: () => {} })
  assert.doesNotThrow(() => partial.info('nothing happens'))
  const missing = createLogPort(undefined)
  assert.doesNotThrow(() => missing.warn('nothing happens'))
})

test('the clock seam is the injected function', () => {
  const clock = createClock(() => 42)
  assert.equal(clock.now(), 42)
  const real = createClock()
  assert.equal(typeof real.now(), 'number')
})

test('the native compaction stub refuses every operation until the host exposes the API', async () => {
  const port = new NativeCompactionPort()
  await assert.rejects(port.fold(/** @type {any} */ ({})), /no public host API yet/)
  await assert.rejects(port.reject(/** @type {any} */ ({})), /no public host API yet/)
  for (const call of [
    () => port.balancedBefore(/** @type {any} */ ({}), 1),
    () => port.balancedAfter(/** @type {any} */ ({}), 1),
    () => port.classify(new Error('x')),
  ]) {
    assert.throws(call, /no public host API yet/, 'selecting the stub must be loud, not silent')
  }
})
