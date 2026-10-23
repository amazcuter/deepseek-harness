/**
 * Byte caps, result-line scanning, value decoding, and the run verdict.
 *
 * These are the protocol rules a node's output must satisfy, so they are
 * pinned here without a real child process; the real-process suites cover the
 * integration.
 */

import { describe, expect, it } from 'vitest'
import {
  CappedStream,
  RESULT_LINE_LIMIT_BYTES,
  RESULT_SENTINEL,
  ResultLineScanner,
  parseNodeValue,
  runVerdict,
  truncationNotice,
} from '../src/output.ts'

const CR = String.fromCharCode(13)
const LF = String.fromCharCode(10)

describe('CappedStream', () => {
  it('retains a stream that stays within its limit', () => {
    const stream = new CappedStream(16, 'head')
    stream.push(Buffer.from('hello ', 'utf8'))
    stream.push(Buffer.from('world', 'utf8'))
    expect(stream.text()).toBe('hello world')
    expect(stream.droppedBytes).toBe(0)
    expect(stream.truncated).toBe(false)
  })

  it('keeps the head of an over-long stream and reports the dropped bytes', () => {
    const stream = new CappedStream(5, 'head')
    stream.push(Buffer.from('abcdefghij', 'utf8'))
    expect(stream.text()).toBe(`abcde${truncationNotice(5, 'head')}`)
    expect(stream.droppedBytes).toBe(5)
    expect(stream.truncated).toBe(true)
  })

  it('keeps the tail of an over-long stream', () => {
    const stream = new CappedStream(5, 'tail')
    stream.push(Buffer.from('abcdefghij', 'utf8'))
    expect(stream.text()).toBe(`${truncationNotice(5, 'tail')}fghij`)
  })

  it('drops bytes from the kept edge across several chunks', () => {
    const stream = new CappedStream(4, 'tail')
    stream.push(Buffer.from('ab', 'utf8'))
    stream.push(Buffer.from('cd', 'utf8'))
    stream.push(Buffer.from('ef', 'utf8'))
    expect(stream.text()).toBe(`${truncationNotice(2, 'tail')}cdef`)
  })
})

describe('truncationNotice', () => {
  it('names the dropped edge', () => {
    expect(truncationNotice(3, 'head')).toContain('truncated from the end')
    expect(truncationNotice(3, 'tail')).toContain('truncated from the start')
  })
})

describe('ResultLineScanner', () => {
  it('separates the result line from the log lines', () => {
    const log = new CappedStream(4096, 'head')
    const scanner = new ResultLineScanner(log)
    scanner.push(Buffer.from(`first log${LF}${RESULT_SENTINEL} "{\\"a\\":1}"${LF}last log${LF}`, 'utf8'))
    expect(scanner.finish()).toEqual({ kind: 'found', payload: '"{\\"a\\":1}"' })
    expect(log.text()).toBe(`first log${LF}last log${LF}`)
  })

  it('reassembles a line split across chunks and decodes a split multibyte character', () => {
    const log = new CappedStream(4096, 'head')
    const scanner = new ResultLineScanner(log)
    const bytes = Buffer.from(`日志${LF}${RESULT_SENTINEL} "1"${LF}`, 'utf8')
    scanner.push(bytes.subarray(0, 4))
    scanner.push(bytes.subarray(4, 6))
    scanner.push(bytes.subarray(6))
    expect(scanner.finish()).toEqual({ kind: 'found', payload: '"1"' })
    expect(log.text()).toBe(`日志${LF}`)
  })

  it('normalizes a CRLF line to one line ending', () => {
    const log = new CappedStream(4096, 'head')
    const scanner = new ResultLineScanner(log)
    scanner.push(Buffer.from(`windows log${CR}${LF}${RESULT_SENTINEL} "1"${CR}${LF}`, 'utf8'))
    expect(scanner.finish()).toEqual({ kind: 'found', payload: '"1"' })
    expect(log.text()).toBe(`windows log${LF}`)
  })

  it('flushes a final line that has no terminating newline', () => {
    const log = new CappedStream(4096, 'head')
    const scanner = new ResultLineScanner(log)
    scanner.push(Buffer.from('tail without newline', 'utf8'))
    expect(scanner.finish()).toEqual({ kind: 'missing' })
    expect(log.text()).toBe(`tail without newline${LF}`)
  })

  it('reports a missing result line', () => {
    const scanner = new ResultLineScanner(new CappedStream(4096, 'head'))
    scanner.push(Buffer.from(`only a log${LF}`, 'utf8'))
    expect(scanner.finish()).toEqual({ kind: 'missing' })
  })

  it('reports more than one result line as ambiguous', () => {
    const scanner = new ResultLineScanner(new CappedStream(4096, 'head'))
    scanner.push(Buffer.from(`${RESULT_SENTINEL} "1"${LF}${RESULT_SENTINEL} "2"${LF}`, 'utf8'))
    expect(scanner.finish()).toEqual({ kind: 'ambiguous', count: 2 })
  })

  it('reports a result line above the accepted size', () => {
    const scanner = new ResultLineScanner(new CappedStream(4096, 'head'))
    scanner.push(Buffer.from(`${RESULT_SENTINEL} ${'x'.repeat(RESULT_LINE_LIMIT_BYTES + 1)}${LF}`, 'utf8'))
    expect(scanner.finish()).toEqual({ kind: 'oversized' })
  })
})

describe('parseNodeValue', () => {
  it('decodes the two-layer JSON a node returns', () => {
    expect(parseNodeValue(JSON.stringify(JSON.stringify({ a: 1 })))).toEqual({ a: 1 })
  })

  it('keeps a JSON null value distinguishable from an invalid return', () => {
    expect(parseNodeValue(JSON.stringify('null'))).toBeNull()
  })

  it('rejects a payload that is not JSON', () => {
    expect(parseNodeValue('not json')).toBeUndefined()
  })

  it('rejects a payload that is JSON but not a string', () => {
    expect(parseNodeValue('1')).toBeUndefined()
  })

  it('rejects a string payload that is not JSON', () => {
    expect(parseNodeValue(JSON.stringify('not json'))).toBeUndefined()
  })
})

describe('runVerdict', () => {
  const facts = { scan: { kind: 'missing' as const }, exitCode: 0, timedOut: false, nodeId: 'n1', timeoutMs: 10 }

  it('reports a deadline', () => {
    expect(runVerdict({ ...facts, timedOut: true })).toEqual({
      ok: false,
      code: 'node/timeout',
      message: 'node "n1" exceeded 10 ms and its process tree was terminated',
    })
  })

  it('reports an oversized result', () => {
    expect(runVerdict({ ...facts, scan: { kind: 'oversized' } })).toMatchObject({ ok: false, code: 'node/output-too-large' })
  })

  it('reports ambiguous result lines', () => {
    expect(runVerdict({ ...facts, scan: { kind: 'ambiguous', count: 3 } })).toEqual({
      ok: false,
      code: 'node/invalid-return',
      message: 'node "n1" printed 3 result lines; exactly one is required',
    })
  })

  it('reports a clean exit that printed no result', () => {
    expect(runVerdict(facts)).toEqual({
      ok: false,
      code: 'node/invalid-return',
      message: 'node "n1" exited with code 0 without printing a result line',
    })
  })

  it('reports the wrapper protocol exit code as an invalid return', () => {
    expect(runVerdict({ ...facts, exitCode: 2 })).toEqual({
      ok: false,
      code: 'node/invalid-return',
      message: 'node "n1" exited with code 2 without printing a result line',
    })
  })

  it('reports a nonzero exit with no result as an exception', () => {
    expect(runVerdict({ ...facts, exitCode: 1 })).toEqual({
      ok: false,
      code: 'node/exception',
      message: 'node "n1" failed with exit code 1; see stderr',
    })
  })

  it('reports a result line that does not hold a JSON string', () => {
    expect(runVerdict({ ...facts, scan: { kind: 'found', payload: 'nope' } })).toEqual({
      ok: false,
      code: 'node/invalid-return',
      message: 'node "n1" returned a value that is not a JSON string holding JSON',
    })
  })

  it('returns the decoded value', () => {
    expect(runVerdict({ ...facts, scan: { kind: 'found', payload: JSON.stringify('{"ok":true}') } })).toEqual({ ok: true, value: { ok: true } })
  })
})
