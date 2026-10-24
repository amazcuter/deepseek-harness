/**
 * One scripted LLM adapter for the agent-executor suites: each model call
 * consumes the next script entry, and every request is recorded so a case can
 * assert what the child Agent saw.
 *
 * The module is package-local so the suites own their fake transport instead of
 * reaching into another package's tests.
 *
 * @module @metaworkflow/workflow-agent-executor/tests/support/mock-adapter
 */

import type { GenerateOptions, LlmModelReasoningInfo, StreamChunk } from '@metaworkflow/llm'
import { LlmAdapter, ReasoningEffortId, ToolCallId } from '@metaworkflow/llm'

/** One scripted response: literal chunks, or chunks computed from the request. */
export type ScriptEntry = StreamChunk[] | ((options: GenerateOptions) => StreamChunk[]) | 'hang'

/**
 * A plain text response.
 * @param text - assistant text the call streams.
 * @returns the chunks.
 */
export function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/**
 * A response the provider cut off at the output-token ceiling.
 * @param text - assistant text delivered before the cutoff.
 * @returns the chunks.
 */
export function maxTokensResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ]
}

/**
 * A response whose single step calls one tool.
 * @param rawCallId - adapter call id.
 * @param name - tool name to call.
 * @param args - arguments to serialize.
 * @returns the chunks.
 */
export function toolCallResponse(rawCallId: string, name: string, args: object): StreamChunk[] {
  const callId = ToolCallId(rawCallId)
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: argumentsJson.slice(0, 5) },
    { type: 'tool-call-delta', index: 0, id: callId, argumentsDelta: argumentsJson.slice(5) },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: callId, name, arguments: argumentsJson },
    },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/**
 * One response whose single step calls several tools in order.
 * @param calls - tool name and arguments per call.
 * @returns the chunks.
 */
export function multiToolCallResponse(calls: readonly { readonly name: string; readonly args: object }[]): StreamChunk[] {
  const chunks: StreamChunk[] = []
  for (const [index, call] of calls.entries()) {
    const callId = ToolCallId(`multi-${String(index)}`)
    const argumentsJson = JSON.stringify(call.args)
    chunks.push(
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'tool-call-delta', index, id: callId, name: call.name, argumentsDelta: argumentsJson },
      { type: 'block-end', index, block: { type: 'tool-call', id: callId, name: call.name, arguments: argumentsJson } },
    )
  }
  chunks.push(
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  )
  return chunks
}

/** Adapter driven by a script that records every request it receives. */
export class ScriptedAdapter extends LlmAdapter {
  /** Every request the child Agents made, in call order. */
  readonly requests: GenerateOptions[] = []

  /**
   * @param script - one entry per model call; an exhausted script fails the call.
   * @param efforts - selectable reasoning efforts the route advertises.
   */
  constructor(
    private readonly script: ScriptEntry[],
    private readonly efforts: readonly string[] = [],
  ) {
    super()
  }

  override resolveModel(provider: string, model: string) {
    const reasoning: LlmModelReasoningInfo | undefined = this.efforts.length === 0
      ? undefined
      : { efforts: this.efforts.map(id => ({ id: ReasoningEffortId(id), name: id })) }
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...reasoning === undefined ? {} : { reasoning },
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('ScriptedAdapter: script exhausted')
    if (entry === 'hang') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial' }
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted) {
          reject(new Error('aborted'))
          return
        }
        options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })
      return
    }
    const chunks = typeof entry === 'function' ? entry(options) : entry
    for (const chunk of chunks) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}
