// The prompt section (docs/10 §3, §10): one module names what the host injects into the system
// prompt, at which order, and under which byte budget. The strings themselves stay in
// `domain/texts.js` — the single file every model-facing string lives in (AGENTS.md constraint 9) —
// and this module is the only consumer that turns them into a registration.
//
// A change that grows the section fails `test/prompt-budget.test.js` against SECTION_BUDGET_CHARS
// before it can grow the total prompt surface.

import * as texts from '../domain/texts.js'

/** The name the host's prompt-section registry keys this section by. */
export const SECTION_NAME = 'task-folding'

/** Ascending order beside the host's own sections; pinned by test/plugin.test.js. */
export const PROMPT_ORDER = 650

/** The section's own ceiling (docs/04 §4): the protocol plus its one discipline line. */
export const SECTION_BUDGET_CHARS = 800

/**
 * The registration the plugin hands to `ctx.systemPrompt.section` (docs/02 §4). It is built on
 * demand, so the one string the model reads is always the text in `domain/texts.js`.
 *
 * @returns {{ name: string, order: number, text: string }}
 */
export function promptSection() {
  return { name: SECTION_NAME, order: PROMPT_ORDER, text: texts.PROMPT_SECTION }
}
