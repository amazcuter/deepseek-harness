/** The sidebar's workflow-projects entry icon; the sidebar owns the button, label, and selected state around it. */

import type { ReactNode } from 'react'
import { IconFolderOpenOutlineRegular } from '@metaworkflow/client-ui-primitives'
import type { PropsRuntime } from '@metaworkflow/client-ui-slots'
import type {} from '@metaworkflow/client-ui-sidebar/client'

/**
 * Render the project glyph at the size the sidebar asks for.
 * @param props - the sidebar's icon share: the requested edge and whether the panel is selected.
 * @returns the icon element.
 */
export function ProjectsPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return <IconFolderOpenOutlineRegular size={size} />
}
