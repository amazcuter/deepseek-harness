/**
 * The decision tool as its consumers see it: its parameter schema, the request
 * sink one call records, the turn the call concludes, the one-pending-request
 * rule, and the card metadata a pending request persists.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@metaworkflow/llm'
import SystemPrompt from '@metaworkflow/system-prompt'
import ToolRuntime from '@metaworkflow/tools'
import type { ToolExecutionResult } from '@metaworkflow/tools'
import {
  DECISION_CARD_TITLE,
  DECISION_TOOL_DESCRIPTION,
  DECISION_TOOL_NAME,
  createRequestDecisionTool,
} from '../src/index.ts'
import type { DecisionRequest } from '../src/index.ts'

const signal = new AbortController().signal

/** One mounted composition plus the requests its tool recorded. */
interface Harness {
  readonly ctx: Context
  readonly requested: DecisionRequest[]
  readonly tool: ReturnType<typeof createRequestDecisionTool>
  call(args: unknown): Promise<ToolExecutionResult>
  close(): Promise<void>
}

/**
 * Mount the tool on a real tool runtime.
 * @param options - overrides for the created tool and its request sink.
 * @returns the mounted harness.
 */
async function mount(options: {
  name?: string
  description?: string
  requests?: string[]
  failFirst?: Error
} = {}): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const requested: DecisionRequest[] = []
  const ids = options.requests ?? ['decision-1']
  let rejected = false
  const tool = createRequestDecisionTool({
    ...options.name === undefined ? {} : { name: options.name },
    ...options.description === undefined ? {} : { description: options.description },
    onRequest(request) {
      if (options.failFirst !== undefined && !rejected) {
        rejected = true
        return Promise.reject(options.failFirst)
      }
      requested.push(request)
      return ids[requested.length - 1] as string
    },
  })
  tool.attach(ctx)
  return {
    ctx,
    requested,
    tool,
    async call(args) {
      return await ctx.tools.execute({
        callId: ToolCallId(`call-${String(requested.length)}`),
        name: tool.name,
        arguments: args,
        signal,
      })
    },
    async close() {
      await ctx.fiber.dispose()
    },
  }
}

/** The model-facing text one result carries. */
function text(result: ToolExecutionResult): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

describe('decision tool definition', () => {
  it('declares the question, options, and detail parameters', async () => {
    const h = await mount()
    try {
      expect(h.tool.name).toBe(DECISION_TOOL_NAME)
      expect(h.tool.description).toBe(DECISION_TOOL_DESCRIPTION)
      expect(h.tool.parameters).toMatchObject({
        type: 'object',
        properties: {
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          detail: {},
        },
        required: ['question'],
      })
      expect(h.ctx.tools.schemas().map(schema => schema.name)).toEqual([DECISION_TOOL_NAME])
    } finally {
      await h.close()
    }
  })

  it('accepts a deployment override for the tool name and description', async () => {
    const h = await mount({ name: 'ask_coordinator', description: 'Ask the coordinator.' })
    try {
      expect(h.tool.name).toBe('ask_coordinator')
      expect(h.tool.description).toBe('Ask the coordinator.')
      expect(h.ctx.tools.schemas()[0]?.name).toBe('ask_coordinator')
    } finally {
      await h.close()
    }
  })

  it('reports the card title the UI renders', () => {
    expect(DECISION_CARD_TITLE).toBe('Waiting for a coordinator decision')
  })
})

describe('recording one request', () => {
  it('records the question, its options, and its detail, and concludes the turn', async () => {
    const h = await mount()
    try {
      const result = await h.call({
        question: 'Ship the release?',
        options: ['yes', 'no'],
        detail: { branch: 'main' },
      })
      expect(result).toMatchObject({ isError: false, value: { status: 'pending', requestId: 'decision-1' } })
      expect(text(result)).toBe('Waiting for the project coordinator to answer decision decision-1.')
      expect(h.requested).toEqual([{
        question: 'Ship the release?',
        options: ['yes', 'no'],
        detail: { branch: 'main' },
      }])
      expect(result.concludesTurn).toBe(true)
      expect(result.meta).toEqual({ title: DECISION_CARD_TITLE, summary: 'Ship the release?' })
    } finally {
      await h.close()
    }
  })

  it('records a question without options or detail', async () => {
    const h = await mount()
    try {
      const result = await h.call({ question: 'Which environment?' })
      expect(result).toMatchObject({ isError: false, value: { status: 'pending', requestId: 'decision-1' } })
      expect(h.requested).toEqual([{ question: 'Which environment?' }])
    } finally {
      await h.close()
    }
  })

  it('refuses a second request in the same attempt', async () => {
    const h = await mount({ requests: ['decision-1', 'decision-2'] })
    try {
      await h.call({ question: 'first?' })
      const second = await h.call({ question: 'second?' })
      expect(second.isError).toBe(true)
      expect(text(second)).toContain('already waits for decision decision-1')
      expect(h.requested).toHaveLength(1)
    } finally {
      await h.close()
    }
  })

  it('reports a rejected request sink and leaves the attempt free to ask again', async () => {
    const h = await mount({
      requests: ['decision-1'],
      failFirst: new Error('the decision row could not be written'),
    })
    try {
      const failed = await h.call({ question: 'first?' })
      expect(failed.isError).toBe(true)
      expect(text(failed)).toContain('the decision row could not be written')
      // A rejected sink records nothing, so the attempt is not left waiting on
      // a request the coordinator never received.
      await expect(h.call({ question: 'second?' })).resolves.toMatchObject({
        isError: false,
        value: { status: 'pending', requestId: 'decision-1' },
      })
      expect(h.requested).toEqual([{ question: 'second?' }])
    } finally {
      await h.close()
    }
  })

  it('backfills invalid arguments instead of recording them', async () => {
    const h = await mount()
    try {
      for (const args of [{}, { question: 4 }, { question: 'why', options: [4] }]) {
        const result = await h.call(args)
        expect(result.isError).toBe(true)
      }
      expect(h.requested).toEqual([])
    } finally {
      await h.close()
    }
  })

  it('presents a replayed call whose arguments carry no question', async () => {
    const h = await mount()
    try {
      await h.call({ question: 'Ship it?' })
      // Presentation runs on logged arguments, which a live call could never
      // produce in this shape.
      expect(h.tool.output.presentationMeta?.({}, null)).toEqual({
        title: DECISION_CARD_TITLE,
        summary: 'no question recorded',
      })
      expect(h.tool.output.presentationMeta?.('not-an-object', null)).toEqual({
        title: DECISION_CARD_TITLE,
        summary: 'no question recorded',
      })
    } finally {
      await h.close()
    }
  })

  it('bounds the presented summary of a long question', async () => {
    const h = await mount()
    try {
      const question = 'x'.repeat(300)
      await h.call({ question })
      const meta = h.tool.output.presentationMeta?.({ question }, null) as { readonly summary: string }
      expect(meta.summary).toHaveLength(201)
      expect(meta.summary.endsWith('…')).toBe(true)
    } finally {
      await h.close()
    }
  })
})
