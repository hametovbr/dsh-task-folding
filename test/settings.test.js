// Settings: the Config schema shape (docs/03 §10) and the readers that never throw.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { FIELDS, buildConfig, clamp, defaults, readSettings } from '../host/domain/settings.js'
import { withVolatiles } from './fixtures/tools.js'

test('defaults match the documented table', () => {
  assert.deepEqual(defaults(), {
    minSpanTokens: 2000,
    delegateEnabled: true,
    implicitTurnFold: true,
    minSummaryChars: 200,
    maxSummaryRatio: 0.5,
    staleTaskSteps: 25,
    showTaskBar: false,
    summarizationProvider: '',
    summarizationModel: '',
  })
})

test('readSettings unwraps volatile readers and clamps out-of-range values', () => {
  const config = withVolatiles({
    minSpanTokens: 500,
    delegateEnabled: false,
    implicitTurnFold: true,
    minSummaryChars: 50,
    maxSummaryRatio: 0.2,
    staleTaskSteps: 40,
    showTaskBar: true,
    summarizationProvider: ' deepseek ',
    summarizationModel: 'deepseek-chat',
  })
  assert.deepEqual(readSettings(config), {
    minSpanTokens: 500,
    delegateEnabled: false,
    implicitTurnFold: true,
    minSummaryChars: 50,
    maxSummaryRatio: 0.2,
    staleTaskSteps: 40,
    showTaskBar: true,
    summarizationProvider: 'deepseek',
    summarizationModel: 'deepseek-chat',
  })
})

test('readSettings falls back to defaults for missing, wrong-typed and unreadable values', () => {
  const base = defaults()
  assert.deepEqual(readSettings(undefined), base)
  assert.deepEqual(readSettings(null), base)
  assert.deepEqual(readSettings('nonsense'), base)
  assert.deepEqual(readSettings({}), base)
  assert.deepEqual(
    readSettings({
      minSpanTokens: 'many',
      delegateEnabled: 'yes',
      minSummaryChars: 12.7,
      maxSummaryRatio: Number.NaN,
      staleTaskSteps: 3,
      showTaskBar: 1,
      summarizationProvider: 7,
      summarizationModel: undefined,
    }),
    { ...base, minSummaryChars: 13, staleTaskSteps: 5 },
  )
  assert.deepEqual(readSettings({ minSpanTokens: 5_000_000, maxSummaryRatio: 4, staleTaskSteps: 99_999 }), {
    ...base,
    minSpanTokens: 1_000_000,
    maxSummaryRatio: 0.9,
    staleTaskSteps: 1000,
  })
  const broken = {
    get() {
      throw new Error('gone')
    },
  }
  assert.deepEqual(readSettings({ minSpanTokens: broken }), base)
})

test('clamp keeps integers integral and honours every field kind', () => {
  assert.equal(clamp(/** @type {any} */ (FIELDS.minSpanTokens), 12.4), 12)
  assert.equal(clamp(/** @type {any} */ (FIELDS.minSpanTokens), -5), 0)
  assert.equal(clamp(/** @type {any} */ (FIELDS.maxSummaryRatio), 0), 0.05)
  assert.equal(clamp(/** @type {any} */ (FIELDS.delegateEnabled), true), true)
  assert.equal(clamp(/** @type {any} */ (FIELDS.delegateEnabled), 'yes'), true)
  assert.equal(clamp(/** @type {any} */ (FIELDS.summarizationModel), ' x '), 'x')
})

test('buildConfig declares every field as a described volatile with its default and bounds', () => {
  const recorder = recordZ()
  const schema = buildConfig(/** @type {any} */ (recorder.z))
  assert.deepEqual(recorder.objectKeys, Object.keys(FIELDS))
  assert.ok(schema.shape && typeof schema.shape === 'object')
  for (const [key, field] of Object.entries(FIELDS)) {
    const chain = recorder.chains.get(key)
    assert.ok(chain, `${key} was not built`)
    assert.equal(chain.default, field.def, `${key} default`)
    assert.equal(chain.volatile, true, `${key} volatile`)
    assert.equal(typeof chain.description, 'string', `${key} description`)
    assert.ok(chain.description.length > 0, `${key} description is not empty`)
  }
  assert.deepEqual(pick(recorder.chains.get('minSpanTokens')), {
    kind: 'number',
    min: 0,
    max: 1_000_000,
    step: 1,
  })
  assert.deepEqual(pick(recorder.chains.get('maxSummaryRatio')), { kind: 'number', min: 0.05, max: 0.9 })
  assert.equal(pick(recorder.chains.get('delegateEnabled')).kind, 'boolean')
  assert.equal(pick(recorder.chains.get('showTaskBar')).kind, 'boolean')
  assert.equal(pick(recorder.chains.get('summarizationProvider')).kind, 'string')
})

/**
 * The bounds of one recorded chain, without the annotations every field carries.
 *
 * @param {any} chain
 */
function pick(chain) {
  /** @type {Record<string, any>} */
  const out = { kind: chain.kind }
  for (const key of ['min', 'max', 'step']) if (chain[key] !== undefined) out[key] = chain[key]
  return out
}

/**
 * A stand-in for schemastery that records the builder chain of each field. buildConfig creates
 * the fields in `Object.keys(FIELDS)` order, so the recorder infers the key from creation order.
 */
function recordZ() {
  const keys = Object.keys(FIELDS)
  /** @type {Map<string, Record<string, any>>} */
  const chains = new Map()
  /** @type {{ objectKeys?: string[] }} */
  const state = {}
  let created = 0

  /**
   * @param {string} kind
   * @param {any} shape
   */
  function field(kind, shape) {
    const key = /** @type {string} */ (keys[created++])
    /** @type {Record<string, any>} */
    const chain = { kind }
    chains.set(key, chain)
    /** @type {any} */
    const api = {
      /** @param {unknown} value */
      min(value) {
        chain.min = value
        return api
      },
      /** @param {unknown} value */
      max(value) {
        chain.max = value
        return api
      },
      /** @param {unknown} value */
      step(value) {
        chain.step = value
        return api
      },
      /** @param {unknown} value */
      default(value) {
        chain.default = value
        return api
      },
      /** @param {unknown} value */
      description(value) {
        chain.description = value
        return api
      },
      volatile() {
        chain.volatile = true
        return api
      },
    }
    return Object.assign(api, shape)
  }

  const z = {
    number: () => field('number', {}),
    boolean: () => field('boolean', {}),
    string: () => field('string', {}),
    /** @param {Record<string, any>} shape */
    object(shape) {
      state.objectKeys = Object.keys(shape)
      return { shape }
    },
  }
  return {
    z,
    chains,
    get objectKeys() {
      return state.objectKeys
    },
  }
}
