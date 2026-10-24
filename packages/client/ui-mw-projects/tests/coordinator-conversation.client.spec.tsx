// @vitest-environment jsdom
/**
 * The coordinator Conversation entry: the shared `conversation.content` Factory
 * rendered with the chat view selected, its fallback when the composition
 * registers no Conversation, and the chat view forwarding the Session body.
 */
import { cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { allowAllAccess } from '@metaworkflow/client-test-runtime'
import type { PropsRenderFactories } from '@metaworkflow/client-ui-slots'
import type { SessionId } from '@metaworkflow/session/types'
import {
  CoordinatorChatView, CoordinatorConversation, type CoordinatorChatViewProps,
  type CoordinatorConversationProps,
} from '../src/client/CoordinatorConversation.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

/** Translate from the shipped dictionary. */
const t = ((key: keyof typeof zh): string => zh[key]) as CoordinatorConversationProps['t']

/** Framework seats the entry never reads. */
const unusedStandardHook = (): never => { throw new Error('The coordinator entry reads no global state') }

/** The entry props a case supplies the factory seat for. */
function entryProps(
  renderFactorySlot: PropsRenderFactories['renderFactorySlot'],
): CoordinatorConversationProps {
  return {
    sessionId: 'session-coordinator' as SessionId,
    useSession: unusedStandardHook,
    useChat: unusedStandardHook,
    useTrajectory: unusedStandardHook,
    useConversation: unusedStandardHook,
    useInput: unusedStandardHook,
    useProjection: unusedStandardHook,
    usePanelInfo: unusedStandardHook,
    useSessions: unusedStandardHook,
    useWorkspaces: unusedStandardHook,
    useSessionStatus: unusedStandardHook,
    useSessionRetainInfo: unusedStandardHook,
    useResource: unusedStandardHook,
    inputActions: unreadInputActions,
    ...allowAllAccess,
    t,
    renderFactorySlot,
  }
}

/** Input actions the coordinator entry never reads. */
const unreadInputActions = {
  captureInsertion: () => ({ start: 0, end: 0, draftRev: 0 }),
  insertText: () => false,
  setDraft: () => {},
  persistDraft: () => {},
  addAttachments: () => true,
  removeAttachment: () => {},
  pruneAttachments: () => {},
  submit: () => {},
}

/** The occurrence selections the entry passed to the Factory call. */
interface FactoryCallOptions {
  readonly slots?: Readonly<Record<string, unknown>>
}

describe('CoordinatorConversation', () => {
  it('renders the shared Conversation content as an embedded chat', () => {
    const renderFactorySlot = vi.fn<PropsRenderFactories['renderFactorySlot']>(
      () => <div data-conversation="">统筹对话</div>,
    )
    render(<CoordinatorConversation {...entryProps(renderFactorySlot)} />)
    expect(screen.getByText('统筹对话')).toBeTruthy()
    expect(renderFactorySlot).toHaveBeenCalledOnce()
    const [name, inputs, options] = renderFactorySlot.mock.calls[0] ?? []
    expect(name).toBe('conversation.content')
    expect(inputs).toEqual({ variant: 'embedded', phase: 'active', hero: false })
    expect((options as FactoryCallOptions | undefined)?.slots?.['views']).toBe(CoordinatorChatView)
  })

  it('says the composition serves no Conversation when the Factory is missing', () => {
    // A missing Factory definition renders the occurrence fallback.
    const missing = vi.fn<PropsRenderFactories['renderFactorySlot']>(
      (_name, _props, options) => <>{options?.fallback ?? null}</>,
    )
    render(<CoordinatorConversation {...entryProps(missing)} />)
    expect(screen.getByText(zh['workbench.chat.missing'])).toBeTruthy()
  })
})

describe('CoordinatorChatView', () => {
  it('renders the chat view of the Session body', () => {
    const dispatch = vi.fn<() => ReactNode>(() => <div data-chat="">聊天</div>)
    const props: CoordinatorChatViewProps = { renderSlot: dispatch }
    render(<CoordinatorChatView {...props} />)
    expect(screen.getByText('聊天')).toBeTruthy()
  })
})
