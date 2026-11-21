/* global window */
// Browser half of dsh-task-folding (docs/03 §9): a compact task dock in the composer context stack
// and the bundle's own configuration card. The Host computes the wire view (`taskFolding`); this
// module only renders it and never folds session events itself.

window.__ModuleLoader__.load({
  id: 'dsh-task-folding',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this module (registered through the Client locale service). */
    const NS = 'taskFolding'
    /** This package's name: the key the Plugins page dispatches `plugins.bundle.config` with. */
    const BUNDLE_KEY = 'dsh-task-folding'
    /**
     * Settings namespace of the bundle's Host row. `settings.describe()` keys every namespace by
     * the Loader entry id (`dsh-settings/src/index.ts`: `ns: entry.options.id`), and the bundle's
     * `cordis.patch.yml` declares that row id as the package name.
     */
    const SETTINGS_NS = 'dsh-task-folding'
    /** Full-width entries above the composer card; renders on the home screen and in conversations. */
    const DOCK_SLOT = 'conversation.input.dock'
    /** A bundle's own configuration, keyed by the bundle's package name on its Plugins page. */
    const CONFIG_SLOT = 'plugins.bundle.config'
    /** The Host projection key (host/projection.js PROJECTION_KEY). */
    const PROJECTION_KEY = 'taskFolding'
    const DOCK_ID = 'task-folding'
    /** Ascending order beside the shipped docks: after todo (0) and goal (10), before the attached queue panel (20). */
    const DOCK_ORDER = 15

    /** English copy; mirrors the `client` section of locale/en.json key for key. */
    const en = {
      'dock.label': 'Open and recently folded tasks',
      'dock.folding': '{n} folding',
      'settings.label': 'Task folding settings',
      'settings.unavailable': 'Task folding settings are not available in this deployment.',
      'settings.readOnly': 'This deployment keeps plugin settings read-only.',
      'settings.notSaved': 'The Host did not accept that value.',
      'settings.fields.minSpanTokens.label': 'Minimum fold size',
      'settings.fields.minSpanTokens.description':
        'A closed task smaller than this many tokens is never folded.',
      'settings.fields.delegateEnabled.label': 'Automatic summaries',
      'settings.fields.delegateEnabled.description':
        'Summarize a task automatically when its own summary is missing or unusable.',
      'settings.fields.minSummaryChars.label': 'Minimum summary length',
      'settings.fields.minSummaryChars.description':
        'A task summary shorter than this is treated as missing.',
      'settings.fields.maxSummaryRatio.label': 'Maximum summary share',
      'settings.fields.maxSummaryRatio.description':
        'A task summary larger than this share of the task is treated as unusable.',
      'settings.fields.staleTaskSteps.label': 'Stale-task reminder',
      'settings.fields.staleTaskSteps.description':
        'Remind the model about a task that stays open for this many steps.',
      'settings.fields.showTaskBar.label': 'Task bar',
      'settings.fields.showTaskBar.description': 'Show open and folding tasks above the composer.',
      'settings.fields.summarizationProvider.label': 'Summary provider',
      'settings.fields.summarizationProvider.description':
        'Provider for automatic summaries; empty uses the session route.',
      'settings.fields.summarizationModel.label': 'Summary model',
      'settings.fields.summarizationModel.description':
        'Model for automatic summaries; set together with the provider.',
    }

    /** The Host's Config fields (host/settings.js FIELDS); the card renders every one of them. */
    const SETTINGS_FIELDS = [
      { key: 'minSpanTokens', kind: 'number', min: 0, max: 1_000_000, step: 1 },
      { key: 'delegateEnabled', kind: 'boolean' },
      { key: 'minSummaryChars', kind: 'number', min: 0, max: 10_000, step: 1 },
      { key: 'maxSummaryRatio', kind: 'number', min: 0.05, max: 0.9, step: 0.05 },
      { key: 'staleTaskSteps', kind: 'number', min: 5, max: 1_000, step: 1 },
      { key: 'showTaskBar', kind: 'boolean' },
      { key: 'summarizationProvider', kind: 'text' },
      { key: 'summarizationModel', kind: 'text' },
    ]

    /**
     * One observable over the Host configuration form. The Client settings service may arrive after
     * this module and may be replaced when its plugin reloads, so the binding is lazy: every read and
     * subscription tracks the current form, and `refresh` republishes after the service appears.
     * The snapshot stays the form's own `ConfigFormSnapshot`, so a selector reads `value.showTaskBar`.
     */
    function createSettingsSource(readForm) {
      let bound
      let off
      const listeners = new Set()
      const emit = () => {
        for (const listener of listeners) listener()
      }
      const sync = () => {
        const form = readForm()
        if (form === bound) return
        if (off !== undefined) off()
        bound = form
        off = form === undefined ? undefined : form.subscribe(emit)
      }
      return {
        getSnapshot() {
          sync()
          return bound === undefined ? undefined : bound.getSnapshot()
        },
        subscribe(listener) {
          listeners.add(listener)
          sync()
          return () => {
            listeners.delete(listener)
          }
        },
        refresh() {
          sync()
          emit()
        },
      }
    }

    /** The dock's one line: no motion, no container of its own, tokens for every colour. */
    const DOCK_CSS = `
.task-folding-dock {
  box-sizing: border-box;
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 10px;
  width: calc(
    100% -
    2 * var(--dsh-composer-side-clearance, 16px) -
    4 * var(--dsh-composer-dock-inset, 8px)
  );
  max-width: calc(var(--dsh-composer-card-max-width, 920px) - 4 * var(--dsh-composer-dock-inset, 8px));
  margin: 0 auto;
  padding: 0 4px;
  font-size: 12px;
  line-height: 20px;
  color: var(--dsw-alias-label-tertiary);
}
.task-folding-group {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0 4px;
  min-width: 0;
}
.task-folding-task {
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}
.task-folding-inner {
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}
.task-folding-separator {
  color: var(--dsw-alias-label-tertiary);
}
.task-folding-folding,
.task-folding-recent {
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}
`

    /** The configuration card's form controls; only theme aliases carry colour. */
    const SETTINGS_CSS = `
.task-folding-settings {
  box-sizing: border-box;
  display: grid;
  gap: 12px;
  margin: 0;
  padding: 0;
}
.task-folding-field {
  display: grid;
  gap: 2px;
}
.task-folding-field-label {
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.task-folding-field-description {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.task-folding-input {
  box-sizing: border-box;
  width: 160px;
  padding: 4px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 13px;
  line-height: 20px;
}
.task-folding-input:disabled {
  color: var(--dsw-alias-label-tertiary);
}
.task-folding-input:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.task-folding-checkbox {
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: var(--dsw-alias-brand-primary);
}
.task-folding-note {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.task-folding-note-error {
  color: var(--dsw-alias-state-error-primary);
}
`

    /** Whole settings snapshot: the card renders every field from it. */
    const selectSnapshot = (snapshot) => snapshot

    /** Whether the Host setting asks for the dock. Anything unknown — no form, still loading — stays hidden. */
    const selectShowTaskBar = (snapshot) => snapshot !== undefined && snapshot.value?.showTaskBar === true

    /** `T7 · Title`, the shape docs/04 §6 gives a fold node without the summary. */
    function taskLabel(task) {
      return task.id + ' · ' + task.title
    }

    /**
     * The fold to show under the open stack: the newest task whose status is `folded`, otherwise
     * the newest recorded one (the wire `recent` list is in creation order, docs/03 §4.4).
     */
    function lastFold(recent) {
      for (let index = recent.length - 1; index >= 0; index -= 1) {
        if (recent[index].status === 'folded') return recent[index]
      }
      return recent.length === 0 ? undefined : recent[recent.length - 1]
    }

    /** The wire view, or nothing to say: no open, no folding, no recent means no dock at all. */
    function hasTasks(view) {
      if (view === undefined || view === null) return false
      return (
        (Array.isArray(view.open) && view.open.length > 0) ||
        (Array.isArray(view.folding) && view.folding.length > 0) ||
        (Array.isArray(view.recent) && view.recent.length > 0)
      )
    }

    /** Compact dock: open stack outermost-first with the innermost highlighted, then folding, then the last fold. */
    function TaskFoldingDock(props) {
      const { useProjection, useShowTaskBar, t } = props
      // Hidden is the default, so an absent settings service or a loading form shows nothing.
      const show = useShowTaskBar(selectShowTaskBar)
      const view = useProjection(PROJECTION_KEY)
      if (!show || !hasTasks(view)) return null
      const open = Array.isArray(view.open) ? view.open : []
      const folding = Array.isArray(view.folding) ? view.folding : []
      const fold = lastFold(Array.isArray(view.recent) ? view.recent : [])
      const children = [h('style', { key: 'style' }, DOCK_CSS)]
      if (open.length > 0) {
        const items = []
        for (let index = 0; index < open.length; index += 1) {
          const task = open[index]
          if (index > 0) {
            items.push(
              h(
                'span',
                {
                  key: 'separator-' + String(index),
                  className: 'task-folding-separator',
                  'aria-hidden': 'true',
                },
                '·',
              ),
            )
          }
          items.push(
            h(
              'span',
              {
                key: 'open-' + String(task.id),
                className:
                  index === open.length - 1 ? 'task-folding-task task-folding-inner' : 'task-folding-task',
              },
              taskLabel(task),
            ),
          )
        }
        children.push(h('span', { key: 'open', className: 'task-folding-group' }, items))
      }
      if (folding.length > 0) {
        children.push(
          h(
            'span',
            { key: 'folding', className: 'task-folding-group task-folding-folding' },
            t('dock.folding', { n: folding.length }),
          ),
        )
      }
      if (fold !== undefined) {
        children.push(
          h('span', { key: 'recent', className: 'task-folding-group task-folding-recent' }, fold.title),
        )
      }
      return h(
        'section',
        { className: 'task-folding-dock', 'data-task-folding-dock': '', 'aria-label': t('dock.label') },
        children,
      )
    }

    /** One input that keeps a local draft and writes the parsed value on blur or Enter. */
    function SettingsInput(props) {
      const { id, field, value, disabled, save } = props
      const current = value === undefined || value === null ? '' : String(value)
      const [draft, setDraft] = React.useState(current)
      React.useEffect(() => {
        setDraft(current)
      }, [current])
      const commit = () => {
        const raw = draft.trim()
        if (field.kind === 'number') {
          const next = Number(raw)
          if (raw === '' || !Number.isFinite(next)) {
            setDraft(current)
            return
          }
          // The Host revision moves on every write; an unchanged field does not need one.
          if (next === value) return
          save(field.key, next)
          return
        }
        if (raw === current) return
        save(field.key, raw)
      }
      return h('input', {
        id,
        type: field.kind === 'number' ? 'number' : 'text',
        className: 'task-folding-input',
        value: draft,
        disabled,
        ...(field.kind === 'number' ? { min: field.min, max: field.max, step: field.step } : {}),
        onChange: (event) => {
          setDraft(event.target.value)
        },
        onBlur: commit,
        onKeyDown: (event) => {
          if (event.key === 'Enter') event.target.blur()
        },
      })
    }

    /** One label, its Host description, and its control. */
    function SettingsField(props) {
      const { t, field, value, disabled, save } = props
      const id = React.useId()
      const control =
        field.kind === 'boolean'
          ? h('input', {
              id,
              type: 'checkbox',
              className: 'task-folding-checkbox',
              checked: value === true,
              disabled,
              onChange: (event) => {
                save(field.key, event.target.checked)
              },
            })
          : h(SettingsInput, { id, field, value, disabled, save })
      return h(
        'div',
        { className: 'task-folding-field' },
        h(
          'label',
          { className: 'task-folding-field-label', htmlFor: id },
          t('settings.fields.' + field.key + '.label'),
        ),
        h(
          'div',
          { className: 'task-folding-field-description' },
          t('settings.fields.' + field.key + '.description'),
        ),
        control,
      )
    }

    /** The bundle's configuration on its Plugins page; values arrive through the settings service. */
    function TaskFoldingSettings(props) {
      const { view, useSettings, writeField, t } = props
      const snapshot = useSettings(selectSnapshot)
      const [failed, setFailed] = React.useState(false)
      if (view !== 'page') return null
      if (snapshot === undefined) return null
      if (snapshot.status === 'loading') return null
      const save = (key, value) => {
        setFailed(false)
        void writeField(key, value).then(
          (accepted) => {
            if (!accepted) setFailed(true)
          },
          () => {
            setFailed(true)
          },
        )
      }
      const disabled = snapshot.status !== 'ready' || snapshot.writable !== true
      const children = [h('style', { key: 'style' }, SETTINGS_CSS)]
      if (snapshot.status === 'unavailable') {
        children.push(
          h('p', { key: 'unavailable', className: 'task-folding-note' }, t('settings.unavailable')),
        )
      } else {
        if (disabled) {
          children.push(h('p', { key: 'read-only', className: 'task-folding-note' }, t('settings.readOnly')))
        }
        if (failed) {
          children.push(
            h(
              'p',
              { key: 'failed', className: 'task-folding-note task-folding-note-error', role: 'status' },
              t('settings.notSaved'),
            ),
          )
        }
        for (const field of SETTINGS_FIELDS) {
          children.push(
            h(SettingsField, {
              key: field.key,
              t,
              field,
              value: snapshot.value?.[field.key],
              disabled,
              save,
            }),
          )
        }
      }
      return h(
        'section',
        {
          className: 'task-folding-settings',
          'data-task-folding-settings': '',
          'aria-label': t('settings.label'),
        },
        children,
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en }), 'task-folding: UI dictionaries')

        // The Host configuration form of this bundle's row, once the Client settings service serves
        // it; both surfaces read through one form so a write from the card reaches the dock at once.
        let form
        const settings = createSettingsSource(() => form)
        ctx.inject(['configForms'], (scope) => {
          form = scope.configForms.get(SETTINGS_NS)
          scope.effect(
            () => () => {
              form = undefined
              settings.refresh()
            },
            'task-folding: configuration form',
          )
          settings.refresh()
        })

        const writeField = (key, value) => {
          const current = form
          return current === undefined ? Promise.resolve(false) : current.set(key, value)
        }

        ctx.slots.inject(DOCK_SLOT, () =>
          ctx.slots.register(
            {
              name: DOCK_SLOT,
              id: DOCK_ID,
              order: DOCK_ORDER,
              locale: NS,
              inject: () => ({ hooks: { showTaskBar: settings } }),
            },
            TaskFoldingDock,
          ),
        )

        ctx.slots.inject(CONFIG_SLOT, () =>
          ctx.slots.register(
            {
              name: CONFIG_SLOT,
              key: BUNDLE_KEY,
              locale: NS,
              inject: () => ({ hooks: { settings }, writeField }),
            },
            TaskFoldingSettings,
          ),
        )
      },
    }
  },
})
