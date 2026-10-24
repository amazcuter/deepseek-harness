/**
 * The completion tool as its consumers see it: the parameter schema derived
 * from the node's output schema, the invalid-argument retry, the two-phase
 * commit behind `tools/result`, the monotonic duplicate guard, and the card
 * metadata an accepted submission records.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@metaworkflow/llm'
import SystemPrompt from '@metaworkflow/system-prompt'
import ToolRuntime from '@metaworkflow/tools'
import type { JsonSchemaNode, ToolExecutionResult, ToolExecutionToken } from '@metaworkflow/tools'
import type { JsonValue } from '@metaworkflow/util-values'
import {
  COMPLETION_INSTRUCTION,
  COMPLETION_TOOL_DESCRIPTION,
  COMPLETION_TOOL_NAME,
  completionInstruction,
  createCompleteNodeTool,
} from '../src/index.ts'

/** The output schema most cases validate against. */
const ANSWER_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
}

const signal = new AbortController().signal

/** One mounted composition plus the values its completion tool accepted. */
interface Harness {
  readonly ctx: Context
  readonly accepted: JsonValue[]
  readonly tool: ReturnType<typeof createCompleteNodeTool>
  call(args: unknown, parent?: ToolExecutionToken): Promise<ToolExecutionResult>
  close(): Promise<void>
}

/**
 * Mount the tool on a real tool runtime and prompt registry.
 * @param options - overrides for the created tool.
 * @returns the mounted harness.
 */
async function mount(options: { outputSchema?: JsonSchemaNode; name?: string; description?: string } = {}): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const accepted: JsonValue[] = []
  const tool = createCompleteNodeTool({
    outputSchema: options.outputSchema ?? ANSWER_SCHEMA,
    ...options.name === undefined ? {} : { name: options.name },
    ...options.description === undefined ? {} : { description: options.description },
    onAccept: (value) => { accepted.push(value) },
  })
  tool.attach(ctx)
  return {
    ctx,
    accepted,
    tool,
    async call(args, parent) {
      return await ctx.tools.execute({
        callId: ToolCallId(`call-${String(accepted.length)}`),
        name: tool.name,
        arguments: args,
        ...parent === undefined ? {} : { parent },
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

describe('completion tool definition', () => {
  it('declares the node output schema as the required value parameter', async () => {
    const h = await mount()
    try {
      expect(h.tool.name).toBe(COMPLETION_TOOL_NAME)
      expect(h.tool.description).toContain('a plain text answer is not a completion')
      expect(h.tool.parameters).toEqual({
        type: 'object',
        properties: { value: ANSWER_SCHEMA },
        required: ['value'],
        additionalProperties: false,
      })
      expect(h.ctx.tools.schemas()).toEqual([{
        name: COMPLETION_TOOL_NAME,
        description: COMPLETION_TOOL_DESCRIPTION,
        parameters: {
          type: 'object',
          properties: { value: ANSWER_SCHEMA },
          required: ['value'],
          additionalProperties: false,
        },
      }])
    } finally {
      await h.close()
    }
  })

  it('accepts a deployment override for the tool name and description', async () => {
    const h = await mount({ name: 'finish_node', description: 'Finish the node.' })
    try {
      expect(h.tool.name).toBe('finish_node')
      expect(h.tool.description).toBe('Finish the node.')
      expect(h.ctx.tools.schemas()[0]?.name).toBe('finish_node')
    } finally {
      await h.close()
    }
  })

  it('names the configured tool in the instruction it attaches', () => {
    expect(completionInstruction('submit_node_result')).toBe(COMPLETION_INSTRUCTION)
    expect(completionInstruction('finish_node')).toContain('`finish_node`')
  })
})

describe('completion submission', () => {
  it('records an accepted value once its own result succeeds', async () => {
    const h = await mount()
    try {
      const result = await h.call({ value: { answer: 'forty-two' } })
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('the submission was rejected')
      expect(result.value).toEqual({ recorded: true })
      expect(result.concludesTurn).toBe(true)
      expect(text(result)).toBe('Node result recorded.')
      expect(result.meta).toEqual({ title: 'Node result', summary: '{"answer":"forty-two"}' })
      expect(h.accepted).toEqual([{ answer: 'forty-two' }])
    } finally {
      await h.close()
    }
  })

  it('renders the attached instruction section naming the completion tool', async () => {
    const h = await mount()
    try {
      const assembly = await h.ctx.systemPrompt.assemble()
      const section = assembly.sections.find(candidate => candidate.name === `tool:${COMPLETION_TOOL_NAME}`)
      expect(section?.text).toBe(COMPLETION_INSTRUCTION)
    } finally {
      await h.close()
    }
  })

  it('backfills an invalid value instead of recording it', async () => {
    const h = await mount()
    try {
      const result = await h.call({ value: { answer: 7 } })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('invalid arguments')
      expect(text(result)).toContain('value.answer')
      expect(h.accepted).toEqual([])
      const missing = await h.call({})
      expect(missing.isError).toBe(true)
      expect(text(missing)).toContain('invalid arguments')
    } finally {
      await h.close()
    }
  })

  it('does not record a submission whose own result a policy turns into a failure', async () => {
    const h = await mount()
    try {
      h.ctx.on('tools/post-execute', async (exec, _result, next) => {
        if (exec.name !== COMPLETION_TOOL_NAME) return await next()
        return { kind: 'block', feedback: [{ type: 'text', text: 'a tool policy refused this result' }] }
      })
      const result = await h.call({ value: { answer: 'refused' } })
      expect(result.isError).toBe(true)
      expect(h.accepted).toEqual([])
    } finally {
      await h.close()
    }
  })

  it('refuses every later call once a result was recorded', async () => {
    const h = await mount()
    try {
      await h.call({ value: { answer: 'first' } })
      const second = await h.call({ value: { answer: 'second' } })
      expect(second.isError).toBe(true)
      expect(text(second)).toContain('already recorded')
      expect(h.accepted).toEqual([{ answer: 'first' }])
    } finally {
      await h.close()
    }
  })

  it('ignores results of tools other than the completion tool', async () => {
    const h = await mount()
    try {
      h.ctx.tools.register({
        name: 'alpha',
        description: 'alpha does nothing.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: { schema: { type: 'object', properties: {}, additionalProperties: false }, render: () => [{ type: 'text', text: 'alpha done.' }] },
        execute: () => Promise.resolve({}),
      })
      const result = await h.ctx.tools.execute({
        callId: ToolCallId('call-alpha'),
        name: 'alpha',
        arguments: {},
        signal,
      })
      expect(result.isError).toBe(false)
      expect(h.accepted).toEqual([])
    } finally {
      await h.close()
    }
  })
})

describe('nested completion under an enclosing transport', () => {
  /**
   * Register one outer tool that dispatches the completion tool with a parent
   * token, the way a PTC transport reaches a native call.
   * @param h - the mounted harness.
   * @param verdict - what the outer tool does after its nested submission.
   * @returns the outer call's result.
   */
  async function dispatchThrough(h: Harness, verdict: 'commit' | 'refuse'): Promise<ToolExecutionResult> {
    h.ctx.tools.register({
      name: 'transport',
      description: 'transport',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'outer done.' }] },
      async execute(_args, exec) {
        const nested = await h.call({ value: { answer: 'nested' } }, exec.token)
        if (nested.isError) throw new Error('the nested submission was rejected')
        // The guard is already active: a second nested dispatch cannot compete.
        const duplicate = await h.call({ value: { answer: 'second' } }, exec.token)
        if (!duplicate.isError || !text(duplicate).includes('already recorded')) {
          throw new Error('the duplicate submission was not refused')
        }
        return 'outer'
      },
    })
    if (verdict === 'refuse') {
      h.ctx.on('tools/post-execute', async (exec, _result, next) => {
        if (exec.name !== 'transport') return await next()
        return { kind: 'block', feedback: [{ type: 'text', text: 'the enclosing call failed' }] }
      })
    }
    return await h.ctx.tools.execute({ callId: ToolCallId('call-transport'), name: 'transport', arguments: {}, signal })
  }

  it('records a nested submission only when its enclosing call succeeds', async () => {
    const h = await mount()
    try {
      const outer = await dispatchThrough(h, 'commit')
      expect(outer.isError).toBe(false)
      expect(h.accepted).toEqual([{ answer: 'nested' }])
    } finally {
      await h.close()
    }
  })

  it('discards a nested submission whose enclosing call fails', async () => {
    const h = await mount()
    try {
      const outer = await dispatchThrough(h, 'refuse')
      expect(outer.isError).toBe(true)
      expect(h.accepted).toEqual([])
    } finally {
      await h.close()
    }
  })
})

describe('completion card metadata', () => {
  it('bounds the summary of a large submitted value', async () => {
    const h = await mount()
    try {
      const result = await h.call({ value: { answer: 'x'.repeat(400) } })
      expect(result.isError).toBe(false)
      const summary = (result.meta as { readonly summary: string }).summary
      expect(summary).toHaveLength(201)
      expect(summary.endsWith('…')).toBe(true)
    } finally {
      await h.close()
    }
  })

  it('summarizes a replayed call that carries no submitted value', async () => {
    const h = await mount()
    try {
      expect(h.tool.output.presentationMeta?.('not an object', { recorded: true }))
        .toEqual({ title: 'Node result', summary: 'no structured value submitted' })
      expect(h.tool.output.presentationMeta?.({}, { recorded: true }))
        .toEqual({ title: 'Node result', summary: 'no structured value submitted' })
    } finally {
      await h.close()
    }
  })
})
