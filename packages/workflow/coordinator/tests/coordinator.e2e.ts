/**
 * Real-model suite: one node asks its project coordinator a decision, and a
 * coordinator turn driven by the deployment model answers it.
 *
 * The suite self-skips without a DeepSeek credential, so keyless CI stays green;
 * the scripted suites own the deterministic behavior.
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@metaworkflow/llm'
import * as LlmDeepSeek from '@metaworkflow/llm-deepseek-api-key'
import { describe, expect, it } from 'vitest'
import { agentNode, definition, mount, type Harness } from './support/harness.ts'

const MODEL_ID = 'deepseek-v4-flash'

/**
 * Mount the official DeepSeek adapter for the real-model route.
 * @param ctx - composition context that owns the plugin.
 * @returns after the provider registered its adapter.
 */
async function mountDeepSeek(ctx: Context): Promise<void> {
  await ctx.plugin(LlmDeepSeek, { models: [{ id: MODEL_ID }] })
}

/**
 * Ask the coordinator's live Session one user message and wait for its turn.
 * @param h - mounted composition.
 * @param text - what the human says to the coordinator.
 * @returns nothing after the turn settles.
 */
async function askCoordinator(h: Harness, text: string): Promise<void> {
  const agent = await h.coordinatorAgent()
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('coordinator with the real model', () => {
  it('answers a decision a node asked and lets the run finish', async () => {
    const h = await mount({ provider: { provider: 'deepseek-official', model: MODEL_ID, mount: mountDeepSeek } })
    try {
      const revision = await h.define(definition([agentNode(
        'pick',
        'Ask the project coordinator whether to use "alpha" or "beta" for the answer, using request_decision, '
        + 'then report the answer you were given.',
      )]))
      const runId = await h.start(revision)
      await h.tick(runId)
      const [request] = h.requested
      expect(request).toBeDefined()

      await h.coordinator.ensureSession(h.projectId)
      await askCoordinator(h, 'Answer any waiting decision with "alpha".')
      await expect(h.scheduler.getRun({ projectId: h.projectId, runId }))
        .resolves.toMatchObject({ status: 'succeeded' })
      expect(await h.store.listPendingDecisions(h.projectId)).toEqual([])
    } finally {
      await h.close()
    }
  })
})
