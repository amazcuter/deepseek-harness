/**
 * Byte-capped stream capture and result-line scanning for one node run.
 *
 * A node's logs and its result share stdout, so the result travels on its own
 * sentinel line and never enters the capped log buffer: truncating a log must
 * not be able to swallow the value. Each stream is capped independently, and
 * stdout keeps its head while stderr keeps its tail, because a Python
 * traceback ends with the exception an operator needs.
 *
 * @module @metaworkflow/workflow-python-runner/output
 */

import { StringDecoder } from 'node:string_decoder'

/** Prefix of the one stdout line that carries a node's result. */
export const RESULT_SENTINEL = '__MWF_RESULT__'

/** Hard cap for that result line; a larger value is reported as too large. */
export const RESULT_LINE_LIMIT_BYTES = 8 * 1024 * 1024

/** Which end of an over-long stream is kept. */
export type KeptEdge = 'head' | 'tail'

/**
 * Render the notice that one capped stream dropped bytes.
 * @param droppedBytes - number of bytes omitted from the captured text.
 * @param edge - kept edge of the stream.
 * @returns the notice line, including its trailing newline.
 */
export function truncationNotice(droppedBytes: number, edge: KeptEdge): string {
  return `[mwf: ${droppedBytes} bytes truncated from the ${edge === 'head' ? 'end' : 'start'} of this stream]\n`
}

/**
 * One captured stream, capped at a byte limit.
 *
 * Bytes are counted before decoding, so a multibyte character that crosses the
 * limit is reported as truncated rather than silently lengthening the buffer.
 */
export class CappedStream {
  private readonly limit: number
  private readonly edge: KeptEdge
  private buffer: Buffer = Buffer.alloc(0)
  private dropped = 0

  /**
   * @param limit - maximum bytes retained.
   * @param edge - which end survives when the stream exceeds `limit`.
   */
  constructor(limit: number, edge: KeptEdge) {
    this.limit = limit
    this.edge = edge
  }

  /** Number of bytes omitted from the retained text. */
  get droppedBytes(): number {
    return this.dropped
  }

  /** Whether any byte was omitted. */
  get truncated(): boolean {
    return this.dropped > 0
  }

  /**
   * Append one chunk, keeping only the configured edge.
   * @param chunk - raw bytes as they arrived from the child.
   * @returns nothing.
   */
  push(chunk: Buffer): void {
    const combined = Buffer.concat([this.buffer, chunk])
    if (combined.length <= this.limit) {
      this.buffer = combined
      return
    }
    const excess = combined.length - this.limit
    this.dropped += excess
    this.buffer = this.edge === 'head' ? combined.subarray(0, this.limit) : combined.subarray(excess)
  }

  /**
   * Decode the retained bytes as UTF-8.
   * @returns the retained text, prefixed or suffixed with its truncation notice when bytes were dropped.
   */
  text(): string {
    const decoded = this.buffer.toString('utf8')
    if (this.dropped === 0) return decoded
    const notice = truncationNotice(this.dropped, this.edge)
    return this.edge === 'head' ? `${decoded}${notice}` : `${notice}${decoded}`
  }
}

/** What one stdout stream said about the node's result. */
export type ResultScan =
  /** Exactly one result line, with the payload after the sentinel. */
  | { readonly kind: 'found'; readonly payload: string }
  /** No result line at all. */
  | { readonly kind: 'missing' }
  /** More than one result line, so the value cannot be attributed. */
  | { readonly kind: 'ambiguous'; readonly count: number }
  /** The one result line exceeded {@link RESULT_LINE_LIMIT_BYTES}. */
  | { readonly kind: 'oversized' }

/**
 * Splits stdout into result lines and log lines, forwarding only log lines to
 * the capped capture.
 *
 * Lines are decoded incrementally, so a multibyte character split across two
 * chunks still decodes once. Only complete lines reach the log buffer during
 * the run; {@link finish} flushes the unterminated remainder.
 */
export class ResultLineScanner {
  private readonly decoder = new StringDecoder('utf8')
  private readonly log: CappedStream
  private pending = ''
  private count = 0
  private payload = ''
  private oversized = false

  /**
   * @param log - capture that receives every non-result line.
   */
  constructor(log: CappedStream) {
    this.log = log
  }

  /**
   * Feed one raw stdout chunk.
   * @param chunk - bytes as they arrived from the child.
   * @returns nothing.
   */
  push(chunk: Buffer): void {
    const text = this.decoder.write(chunk)
    const segments = (this.pending + text).split('\n')
    // `split` always yields at least one segment: the trailing partial line.
    this.pending = segments.at(-1) as string
    for (const segment of segments.slice(0, -1)) this.consume(segment)
  }

  /**
   * Flush the unterminated remainder and report the scan result.
   * @returns what the stream said about the node's result.
   */
  finish(): ResultScan {
    const remainder = this.pending + this.decoder.end()
    this.pending = ''
    if (remainder.length > 0) this.consume(remainder)
    if (this.oversized) return { kind: 'oversized' }
    if (this.count === 0) return { kind: 'missing' }
    if (this.count > 1) return { kind: 'ambiguous', count: this.count }
    return { kind: 'found', payload: this.payload }
  }

  /**
   * Classify one complete line as a result line or a log line.
   *
   * Windows Python writes CRLF on stdout, so the captured log keeps one line
   * ending per line instead of the platform's translation.
   * @param rawLine - one line without its terminating newline.
   * @returns nothing.
   */
  private consume(rawLine: string): void {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.startsWith(RESULT_SENTINEL)) {
      const payload = line.slice(RESULT_SENTINEL.length).trim()
      this.count += 1
      if (Buffer.byteLength(payload, 'utf8') > RESULT_LINE_LIMIT_BYTES) this.oversized = true
      this.payload = payload
      return
    }
    this.log.push(Buffer.from(`${line}\n`, 'utf8'))
  }
}

/** Facts one finished node run contributes to its verdict. */
export interface RunVerdictFacts {
  /** What the stdout stream said about the result line. */
  readonly scan: ResultScan
  /** Process exit code, or `null` when it was killed. */
  readonly exitCode: number | null
  /** Whether the deadline expired. */
  readonly timedOut: boolean
  /** Node id, named in every diagnostic. */
  readonly nodeId: string
  /** Deadline the run used. */
  readonly timeoutMs: number
}

/** What one finished node run produced. */
export type RunVerdict =
  /** The node returned a JSON value. */
  | { readonly ok: true; readonly value: unknown }
  /** The node produced a structured failure. */
  | { readonly ok: false; readonly code: 'node/timeout' | 'node/output-too-large' | 'node/invalid-return' | 'node/exception'; readonly message: string }

/**
 * Decide one node run's outcome from its protocol facts.
 * @param facts - result scan, exit code, deadline state, and the node's identity.
 * @returns the node's value, or the failure a caller reports.
 */
export function runVerdict(facts: RunVerdictFacts): RunVerdict {
  if (facts.timedOut) {
    return { ok: false, code: 'node/timeout', message: `node "${facts.nodeId}" exceeded ${String(facts.timeoutMs)} ms and its process tree was terminated` }
  }
  switch (facts.scan.kind) {
    case 'oversized':
      return { ok: false, code: 'node/output-too-large', message: `node "${facts.nodeId}" printed a result larger than ${String(RESULT_LINE_LIMIT_BYTES)} bytes` }
    case 'ambiguous':
      return { ok: false, code: 'node/invalid-return', message: `node "${facts.nodeId}" printed ${String(facts.scan.count)} result lines; exactly one is required` }
    case 'missing':
      // The wrapper exits 2 for a protocol violation and 1 for a raised
      // exception; any other code means the node left through its own exit.
      return facts.exitCode === 0 || facts.exitCode === 2
        ? { ok: false, code: 'node/invalid-return', message: `node "${facts.nodeId}" exited with code ${String(facts.exitCode)} without printing a result line` }
        : { ok: false, code: 'node/exception', message: `node "${facts.nodeId}" failed with exit code ${String(facts.exitCode)}; see stderr` }
    case 'found': {
      const value = parseNodeValue(facts.scan.payload)
      return value === undefined
        ? { ok: false, code: 'node/invalid-return', message: `node "${facts.nodeId}" returned a value that is not a JSON string holding JSON` }
        : { ok: true, value }
    }
  }
}

/**
 * Decode the value a node returned.
 *
 * The node returns a JSON string, and the wrapper prints it as one JSON string
 * literal, so the payload decodes to a string that must itself be valid JSON.
 * @param payload - text after the result sentinel.
 * @returns the parsed JSON value, or `undefined` when the payload is not two-layer valid JSON.
 */
export function parseNodeValue(payload: string): unknown {
  let decoded: unknown
  try {
    decoded = JSON.parse(payload)
  } catch {
    // A payload that is not JSON at all carries no value to report.
    return undefined
  }
  if (typeof decoded !== 'string') return undefined
  try {
    return JSON.parse(decoded)
  } catch {
    // The node returned text that is not JSON; the runner reports it as an invalid return.
    return undefined
  }
}
