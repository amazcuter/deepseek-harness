// @vitest-environment jsdom
/**
 * The Mermaid import dialog: the two draft fields, the submission gate, and the
 * structured refusal the Host returns — a source line, the refusal code, the
 * validator messages, and the retry that resubmits the same draft.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { zh } from '../src/client/locales.ts'
import type { ImportDraft, ImportState } from '../src/client/projects.ts'
import { ImportDialog, type ImportDialogProps } from '../src/client/ImportDialog.tsx'

afterEach(cleanup)

/** Translate from the shipped dictionary, matching the locale runtime's placeholder form. */
const translate = (dict: typeof zh): ImportDialogProps['t'] => ((key: keyof typeof zh, params?: Record<string, unknown>): string =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    dict[key],
  )) as ImportDialogProps['t']

/** One localized template with its parameters filled in. */
const copy = (key: keyof typeof zh, params: Record<string, unknown> = {}): string =>
  translate(zh)(key, params)

function bench(state: ImportState = { status: 'idle' }, open = true) {
  const onSubmit = vi.fn<(draft: ImportDraft) => void>()
  const onClose = vi.fn()
  const props: ImportDialogProps = {
    t: translate(zh),
    open,
    state,
    onClose,
    onSubmit,
  }
  const view = render(<ImportDialog {...props} />)
  const rerender = (next: ImportState): void => {
    view.rerender(<ImportDialog {...props} state={next} />)
  }
  /** Type one draft into the two fields. */
  const fill = (title: string, source: string): void => {
    fireEvent.change(screen.getByLabelText(zh['import.name']), { target: { value: title } })
    fireEvent.change(screen.getByLabelText(zh['import.source']), { target: { value: source } })
  }
  return { onSubmit, onClose, rerender, fill }
}

describe('ImportDialog', () => {
  it('renders no dialog while it is closed', () => {
    bench({ status: 'idle' }, false)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps the submit disabled until both the name and the source are filled', () => {
    const b = bench()
    const submit = screen.getByRole('button', { name: zh['import.submit'] })
    expect(submit).toHaveProperty('disabled', true)
    b.fill('   ', 'flowchart TD')
    expect(submit).toHaveProperty('disabled', true)
    b.fill('发票处理', '   ')
    expect(submit).toHaveProperty('disabled', true)
    b.fill('发票处理', 'flowchart TD')
    expect(submit).toHaveProperty('disabled', false)
  })

  it('submits the trimmed project name with the flowchart source', () => {
    const b = bench()
    b.fill('  发票处理  ', 'flowchart TD\n  A --> B')
    fireEvent.click(screen.getByRole('button', { name: zh['import.submit'] }))
    expect(b.onSubmit).toHaveBeenCalledExactlyOnceWith({
      title: '发票处理',
      mermaid: 'flowchart TD\n  A --> B',
    })
  })

  it('closes without importing', () => {
    const b = bench()
    fireEvent.click(screen.getByRole('button', { name: zh['action.cancel'] }))
    expect(b.onClose).toHaveBeenCalledOnce()
    expect(b.onSubmit).not.toHaveBeenCalled()
  })

  it('disables both actions and the fields while the Host works', () => {
    const b = bench({ status: 'importing' })
    expect(screen.getByRole('button', { name: zh['action.cancel'] })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: zh['import.submit'] })).toHaveProperty('disabled', true)
    expect(screen.getByLabelText(zh['import.name'])).toHaveProperty('disabled', true)
    expect(screen.getByLabelText(zh['import.source'])).toHaveProperty('disabled', true)
    // The dialog's own close control stays available, so a slow import never traps the panel.
    fireEvent.click(screen.getByRole('button', { name: zh['import.close'] }))
    expect(b.onClose).toHaveBeenCalledOnce()
  })

  it('reports a refused flowcharts line, refusal code, and validator messages', () => {
    const b = bench({ status: 'idle' })
    b.fill('发票处理', 'flowchart TD\n  A -->')
    b.rerender({
      status: 'failed',
      failure: {
        code: 'project/mermaid-invalid',
        message: 'the flowchart cannot be imported: unexpected token',
        line: 2,
        refusalCode: 'mermaid/unsupported-syntax',
      },
    })
    const alert = screen.getByRole('alert', { name: zh['import.failed'] })
    expect(within(alert).getByText(zh['error.project-mermaid-invalid'])).toBeTruthy()
    expect(within(alert).getByText(copy('import.line', { line: 2 }))).toBeTruthy()
    expect(within(alert).getByText(copy('import.code', { code: 'mermaid/unsupported-syntax' }))).toBeTruthy()
    expect(within(alert).getByText('the flowchart cannot be imported: unexpected token')).toBeTruthy()
  })

  it('lists the validator violations of a flow that translated but cannot run', () => {
    const b = bench()
    b.fill('发票处理', 'flowchart TD\n  A --> B')
    b.rerender({
      status: 'failed',
      failure: {
        code: 'project/mermaid-invalid',
        message: 'the flowchart is not a usable definition',
        violations: ['definition/no-entry-node', 'definition/unreachable-node'],
      },
    })
    const alert = screen.getByRole('alert', { name: zh['import.failed'] })
    expect(within(alert).getByText('definition/no-entry-node')).toBeTruthy()
    expect(within(alert).getByText('definition/unreachable-node')).toBeTruthy()
    expect(within(alert).queryByText(copy('import.line', { line: 1 }))).toBeNull()
  })

  it('retries the draft it still holds after a refusal', () => {
    const b = bench()
    b.fill('发票处理', 'flowchart TD\n  A --> B')
    b.rerender({
      status: 'failed',
      failure: { code: 'gateway/internal', message: 'the carrier closed' },
    })
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: zh['error.retry'] }))
    expect(b.onSubmit).toHaveBeenCalledExactlyOnceWith({
      title: '发票处理',
      mermaid: 'flowchart TD\n  A --> B',
    })
  })

  it('hides itself once the Host stored the import', () => {
    const b = bench()
    b.fill('发票处理', 'flowchart TD\n  A --> B')
    b.rerender({ status: 'imported', projectId: 'project-1' as never })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
