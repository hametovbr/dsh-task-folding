/* global window */
// The settings half of dsh-task-folding (docs/03 §9, docs/10 §11): the bundle's own configuration
// card on its Plugins page. Values arrive through the Client settings service; the card only
// renders the Host's Config fields and writes a changed value back through `writeField`.
//
// It is a package-local chunk of `client/module.js`, fetched with
// `require.async('./client.settings-card.js')`. The host's chunk route serves a package-local file
// only when its name starts with `client.`.

window.__ModuleLoader__.load({
  id: 'dsh-task-folding',
  chunk: 'client.settings-card.js',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** The Host's Config fields (host/domain/settings.js FIELDS); the card renders every one of them. */
    const SETTINGS_FIELDS = [
      { key: 'minSpanTokens', kind: 'number', min: 0, max: 1_000_000, step: 1 },
      { key: 'delegateEnabled', kind: 'boolean' },
      { key: 'implicitTurnFold', kind: 'boolean' },
      { key: 'minSummaryChars', kind: 'number', min: 0, max: 10_000, step: 1 },
      { key: 'maxSummaryRatio', kind: 'number', min: 0.05, max: 0.9, step: 0.05 },
      { key: 'staleTaskSteps', kind: 'number', min: 5, max: 1_000, step: 1 },
      { key: 'showTaskBar', kind: 'boolean' },
      { key: 'summarizationProvider', kind: 'text' },
      { key: 'summarizationModel', kind: 'text' },
    ]

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

    return { TaskFoldingSettings }
  },
})
