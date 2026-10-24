/**
 * The project coordinator's Conversation, rendered inside the workbench.
 *
 * The coordinator is an ordinary Session, so the workbench does not reimplement
 * a transcript: this entry renders the shared `conversation.content` Factory with
 * the chat view selected, which is the same content the main conversation view
 * and the right sidebar's chat tabs render. The panel wraps it in the
 * renderer-provided `SessionProvider` bound to the coordinator Session, so the
 * factory resolves that Session's own scope sources.
 */
import type { ReactNode } from 'react'
import type { ConversationViewsProps } from '@metaworkflow/client-ui-conversation/client'
import type {
  PropsLocale, PropsRenderFactories, PropsRuntime,
} from '@metaworkflow/client-ui-slots'
import type { ProjectsKey } from './locales.ts'

/** Copy key of the hint shown when the composition serves no Conversation. */
const MISSING_KEY: ProjectsKey = 'workbench.chat.missing'

declare module '@metaworkflow/client-ui-slots' {
  interface SlotMap {
    /**
     * Coordinator Conversation body of one project workbench. The parent entry
     * renders it inside a Session binding, so this position is Session-scoped.
     */
    'mw.projects.coordinator': { kind: 'single'; scope: 'session' }
  }
}

/** The part of the Conversation View props this selection reads. */
export type CoordinatorChatViewProps = Pick<ConversationViewsProps, 'renderSlot'>

/**
 * Fixed chat selection of the embedded coordinator Conversation.
 * @param props - the View's Session-body dispatch.
 * @returns the chat view of the coordinator Session.
 */
export function CoordinatorChatView({ renderSlot }: CoordinatorChatViewProps): ReactNode {
  return <>{renderSlot('conversation.session', { view: 'chat' })}</>
}

/** Props of the coordinator Conversation entry. */
export type CoordinatorConversationProps =
  PropsRuntime<'mw.projects.coordinator'>
  & PropsLocale<'mw.projects'>
  & PropsRenderFactories

/**
 * Render the coordinator Session as an embedded Conversation.
 * @param props - the factory seat and the panel translator.
 * @returns the shared Conversation content, or a hint when this composition
 * registers no `conversation.content` Factory.
 */
export function CoordinatorConversation({
  t, renderFactorySlot,
}: CoordinatorConversationProps): ReactNode {
  return (
    <>
      {renderFactorySlot(
        'conversation.content',
        { variant: 'embedded', phase: 'active', hero: false },
        {
          slots: { views: CoordinatorChatView },
          fallback: <p>{t(MISSING_KEY)}</p>,
        },
      )}
    </>
  )
}
