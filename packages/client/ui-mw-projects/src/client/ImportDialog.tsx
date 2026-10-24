/**
 * The Mermaid import dialog: a flowchart source and the project name to
 * register, submitted through `projects.importMermaid`.
 *
 * The Host parses and validates before it stores anything, so a refused
 * flowchart creates no project. The refusal comes back structured — a source
 * line, the parser's own code, or the validator messages — and the dialog shows
 * every part of it beside a retry that resubmits the same draft, so a single
 * typo costs neither the text nor the project name.
 */
import { useState, type ReactNode } from 'react'
import { Button, Input, Modal } from '@metaworkflow/client-ui-primitives'
import type { TranslateNS } from '@metaworkflow/client-ui-slots'
import { failureText } from './failures.ts'
import type { ImportDraft, ImportState } from './projects.ts'
import css from './ImportDialog.module.css'

/** The bound translator this component receives from the dashboard panel. */
type Translate = TranslateNS<'mw.projects'>

/** Props of the import dialog. */
export interface ImportDialogProps {
  /** Panel translator. */
  readonly t: Translate
  /** Whether the dialog is open; a completed import closes it without a state reset. */
  readonly open: boolean
  /** Import the composition last ran, which drives the buttons and the refusal face. */
  readonly state: ImportState
  /** Close without importing. */
  readonly onClose: () => void
  /** Submit one draft; the panel closes the dialog once the Host accepts it. */
  readonly onSubmit: (draft: ImportDraft) => void
}

/** The refusal face: every part of the structured error the Host returned. */
function Refusal({ t, state, retry }: {
  readonly t: Translate
  readonly state: ImportState
  readonly retry: () => void
}): ReactNode {
  if (state.status !== 'failed') return null
  const { failure } = state
  return (
    <section className={css.refused} role="alert" aria-label={t('import.failed')}>
      <p className={css.refusedTitle}>{failureText(t, failure)}</p>
      {failure.line !== undefined && (
        <p className={css.refusedDetail}>{t('import.line', { line: failure.line })}</p>
      )}
      {failure.refusalCode !== undefined && (
        <p className={css.refusedDetail}>{t('import.code', { code: failure.refusalCode })}</p>
      )}
      <p className={css.refusedDetail}>{failure.message}</p>
      {failure.violations !== undefined && failure.violations.length > 0 && (
        <ul className={css.violations}>
          {failure.violations.map(violation => <li key={violation}>{violation}</li>)}
        </ul>
      )}
      <Button variant="outline" size="sm" onClick={retry}>{t('error.retry')}</Button>
    </section>
  )
}

/**
 * Render the import dialog.
 * @param props - the open flag, the last import state, and the two callbacks.
 * @returns the dialog, or `null` while it is closed.
 */
export function ImportDialog({ t, open, state, onClose, onSubmit }: ImportDialogProps): ReactNode {
  const [title, setTitle] = useState('')
  const [mermaid, setMermaid] = useState('')
  const busy = state.status === 'importing'
  // A finished import keeps its project open behind the dashboard, so the
  // dialog hides itself instead of closing through a second state write; the
  // next open resets the import state before showing it again.
  const showing = open && state.status !== 'imported'
  const draft: ImportDraft = { title: title.trim(), mermaid }
  const ready = draft.title !== '' && draft.mermaid.trim() !== ''
  const submit = (): void => {
    // The submit button and the retry are the only callers, and both are inert
    // in exactly these two states; the guard keeps a stale closure honest.
    /* v8 ignore next -- disabled controls already prevent both states. */
    if (!ready || busy) return
    onSubmit(draft)
  }
  return (
    <Modal
      open={showing}
      onClose={onClose}
      title={t('import.title')}
      description={t('import.description')}
      closeLabel={t('import.close')}
      className={css.dialog as string}
      footer={(
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>{t('action.cancel')}</Button>
          <Button variant="primary" onClick={submit} disabled={busy || !ready}>{t('import.submit')}</Button>
        </>
      )}
    >
      <div className={css.content}>
        <label className={css.label} htmlFor="mwf-import-title">{t('import.name')}</label>
        <Input
          id="mwf-import-title"
          data-modal-autofocus
          value={title}
          disabled={busy}
          placeholder={t('import.namePlaceholder')}
          aria-label={t('import.name')}
          onChange={(event) => { setTitle(event.target.value) }}
        />
        <label className={css.label} htmlFor="mwf-import-source">{t('import.source')}</label>
        <textarea
          id="mwf-import-source"
          className={css.source}
          value={mermaid}
          disabled={busy}
          rows={12}
          spellCheck={false}
          placeholder={t('import.sourcePlaceholder')}
          aria-label={t('import.source')}
          onChange={(event) => { setMermaid(event.target.value) }}
        />
        <p className={css.hint}>{t('import.hint')}</p>
        <Refusal t={t} state={state} retry={submit} />
      </div>
    </Modal>
  )
}
