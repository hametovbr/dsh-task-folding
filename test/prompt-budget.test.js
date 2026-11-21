// The prompt budget (docs/04 §4): the section plus all three tool schemas, as the model sees
// them, must stay under 3,400 characters. A new sentence anywhere fails here first.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { PROMPT_SECTION } from '../host/texts.js'
import { createTools } from '../host/tools.js'

const TOTAL_BUDGET = 3400

/** Per-part ceilings from docs/04 §4. */
const PART_BUDGET = { prompt: 800, task_begin: 500, task_end: 1100, fold_recall: 1000 }

/** @returns {any[]} */
function toolDefinitions() {
  return createTools(
    /** @type {any} */ ({
      stateOf: async () => ({ nextId: 1, open: [], tasks: {}, order: [], folds: [] }),
      estimator: { span: () => 0, text: () => 0 },
      settings: () => ({}),
    }),
  )
}

test('the prompt section fits its budget', () => {
  assert.ok(PROMPT_SECTION.length <= PART_BUDGET.prompt, `prompt ${PROMPT_SECTION.length}`)
  assert.ok(PROMPT_SECTION.startsWith('Task folding.'), 'the section announces the discipline first')
})

// Q15: beginning a task in the same batch as its first work calls leaves the task span empty, so the
// task closes below the floor and never folds. The fix is this explicit clause; keep it pinned.
test('the prompt asks for task_begin in its own message', () => {
  assert.match(PROMPT_SECTION, /task_begin in its own message, before the work it covers\./)
})

test('each tool schema fits its budget', () => {
  for (const tool of toolDefinitions()) {
    const size = JSON.stringify({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }).length
    assert.ok(
      size <= PART_BUDGET[/** @type {keyof PART_BUDGET} */ (tool.name)],
      `${tool.name} schema is ${size} characters`,
    )
  }
})

test('prompt section plus all tool schemas stay under the total budget', () => {
  let total = PROMPT_SECTION.length
  for (const tool of toolDefinitions()) {
    total += JSON.stringify({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }).length
  }
  assert.ok(total <= TOTAL_BUDGET, `prompt surface is ${total} characters, budget ${TOTAL_BUDGET}`)
})

test('every parameter has a description and no schema uses unsupported keywords', () => {
  for (const tool of toolDefinitions()) {
    for (const [name, schema] of Object.entries(tool.parameters.properties || {})) {
      assert.equal(typeof (/** @type {any} */ (schema).description), 'string', `${tool.name}.${name}`)
    }
    assertSchemaSubset(tool.parameters, tool.name)
  }
})

/**
 * The host accepts only this keyword subset (packages/core/tools/src/json-schema.ts).
 *
 * @param {any} node
 * @param {string} path
 */
function assertSchemaSubset(node, path) {
  if (Array.isArray(node)) {
    for (const [i, entry] of node.entries()) assertSchemaSubset(entry, `${path}[${i}]`)
    return
  }
  if (typeof node !== 'object' || node === null) return
  for (const key of Object.keys(node)) {
    assert.ok(
      [
        'type',
        'oneOf',
        'properties',
        'required',
        'additionalProperties',
        'items',
        'enum',
        'const',
        'description',
        'title',
        'default',
        'examples',
      ].includes(key),
      `${path}.${key} is not in the host's supported subset`,
    )
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties') {
      for (const [name, child] of Object.entries(/** @type {any} */ (value)))
        assertSchemaSubset(child, `${path}.properties.${name}`)
    } else if (key === 'oneOf' || key === 'items') {
      assertSchemaSubset(value, `${path}.${key}`)
    } else if (key === 'required' || key === 'enum') {
      assert.ok(Array.isArray(value), `${path}.${key} must be an array`)
    }
  }
}
