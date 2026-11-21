/* global window */
// The dock half of dsh-task-folding (docs/03 §9, docs/10 §11): a compact task line in the composer
// context stack. The Host computes the wire view (`taskFolding`); this component only renders it
// and never folds session events itself.
//
// It is a package-local chunk of `client/module.js`, fetched with `require.async('./client.dock.js')`.
// The host's chunk route serves a package-local file only when its name starts with `client.`, so
// the file name carries the prefix while its role stays in the second segment.

window.__ModuleLoader__.load({
  id: 'dsh-task-folding',
  chunk: 'client.dock.js',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** The Host projection key (host/domain/projection.js PROJECTION_KEY). */
    const PROJECTION_KEY = 'taskFolding'

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

    return { TaskFoldingDock }
  },
})
