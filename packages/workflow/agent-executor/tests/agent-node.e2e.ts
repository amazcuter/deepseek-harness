/**
 * Real-model suite: one agent node driven end to end by the deployment model.
 *
 * The suite self-skips without a DeepSeek credential, so keyless CI stays green;
 * the fake-transport suites own the deterministic behavior.
 */

import type { Context } from '@deepseek-ai/cordis'
import * as LlmDeepSeek from '@metaworkflow/llm-deepseek-api-key'
import { describe, expect, it } from 'vitest'
import { agentNode, definition, mount } from './support/harness.ts'

const MODEL_ID = 'deepseek-v4-flash'

/**
 * Mount the official DeepSeek adapter for the real-model route.
 * @param ctx - composition context that owns the plugin.
 * @returns after the provider registered its adapter.
 */
async function mountDeepSeek(ctx: Context): Promise<void> {
  await ctx.plugin(LlmDeepSeek, { models: [{ id: MODEL_ID }] })
}

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('agent node with the real model', () => {
  it('commits the structured result the model submits through the completion tool', async () => {
    const h = await mount({
      provider: { provider: 'deepseek-official', model: MODEL_ID, mount: mountDeepSeek },
    })
    try {
      const revision = await h.define(definition([agentNode('greet', {
        instructions: 'Report a short greeting addressed to a workflow maintainer.',
        outputSchema: {
          type: 'object',
          properties: { greeting: { type: 'string' } },
          required: ['greeting'],
          additionalProperties: false,
        },
      })]))
      const runId = await h.start(revision)
      const ticked = await h.tick(runId)
      expect(ticked.status).toBe('succeeded')
      const activations = await h.scheduler.listActivations({ projectId: h.projectId, runId })
      expect(activations.map(activation => activation.status)).toEqual(['succeeded'])
    } finally {
      await h.close()
    }
  })
})
