/**
 * Node directory layout, identifier rules, and the generated entry program.
 */

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PythonRunnerError } from '../src/errors.ts'
import { RESULT_SENTINEL } from '../src/output.ts'
import {
  MAX_NODE_ID_LENGTH,
  MAX_PROJECT_PATH_LENGTH,
  NODE_SOURCE_FILE_NAME,
  NODES_DIRECTORY_NAME,
  WRAPPER_FILE_NAME,
  assertNodeId,
  assertProjectPath,
  nodeDirectory,
  nodeFunctionName,
  wrapperSource,
} from '../src/wrapper.ts'

/** Capture the code of one refusal. */
function refusal(run: () => void): string {
  try {
    run()
  } catch (error: unknown) {
    if (error instanceof PythonRunnerError) return error.code
    throw error
  }
  throw new Error('expected the call to refuse')
}

describe('assertProjectPath', () => {
  it('accepts a path at the documented maximum', () => {
    expect(() => {
      assertProjectPath('p'.repeat(MAX_PROJECT_PATH_LENGTH))
    }).not.toThrow()
  })

  it('refuses a path a Windows process cannot use as its working directory', () => {
    expect(refusal(() => {
      assertProjectPath('p'.repeat(MAX_PROJECT_PATH_LENGTH + 1))
    })).toBe('project/path-too-long')
  })
})

describe('assertNodeId', () => {
  it('accepts ids that name one directory and one Python identifier', () => {
    for (const nodeId of ['a', 'node-1', 'node_1', 'a.b.c', 'A9']) {
      expect(() => {
        assertNodeId(nodeId)
      }).not.toThrow()
    }
  })

  it('refuses an id that could address another directory', () => {
    for (const nodeId of ['', '..', '.hidden', 'a/b', 'a\\b', 'a b']) {
      expect(refusal(() => {
        assertNodeId(nodeId)
      })).toBe('node/invalid-id')
    }
  })

  it('refuses an over-long id', () => {
    expect(refusal(() => {
      assertNodeId('n'.repeat(MAX_NODE_ID_LENGTH + 1))
    })).toBe('node/invalid-id')
  })
})

describe('nodeDirectory', () => {
  it('places every node under the project', () => {
    expect(nodeDirectory('/project', 'n1')).toBe(join('/project', NODES_DIRECTORY_NAME, 'n1'))
  })
})

describe('nodeFunctionName', () => {
  it('keeps an alphanumeric id as it is', () => {
    expect(nodeFunctionName('node_1')).toBe('nodemain_node_1')
  })

  it('replaces characters a Python identifier cannot hold', () => {
    expect(nodeFunctionName('node-1.a')).toBe('nodemain_node_1_a')
  })
})

describe('wrapperSource', () => {
  const source = wrapperSource('nodemain_node_1')

  it('imports the node function and prints the sentinel line', () => {
    expect(source).toContain('from node_main import nodemain_node_1 as __mwf_node__')
    expect(source).toContain(`RESULT_SENTINEL = ${JSON.stringify(RESULT_SENTINEL)}`)
  })

  it('forces ASCII result escaping and the two failure exit codes', () => {
    expect(source).toContain('json.dumps(value, ensure_ascii=True)')
    expect(source).toContain('return 1')
    expect(source).toContain('return 2')
  })

  it('stays pure ASCII so no interpreter encoding can matter', () => {
    expect(/^[\u0020-\u007e\n]*$/u.test(source)).toBe(true)
  })

  it('names the documents it generates', () => {
    expect(NODE_SOURCE_FILE_NAME).toBe('node_main.py')
    expect(WRAPPER_FILE_NAME).toBe('node_runner.py')
  })
})
