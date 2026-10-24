/**
 * Mermaid flowchart parsing: the text subset the importer reads (a header, node
 * statements, links, and comments) and the graph it produces.
 *
 * The parser is a single forward pass over the source lines. It never repairs
 * text it cannot read: a statement outside the subset is refused with a stable
 * code and the line it was written on.
 *
 * @module @metaworkflow/workflow-mermaid-import/parse
 */

import type {
  MermaidDirection,
  MermaidFlowchartGraph,
  MermaidGraphEdge,
  MermaidGraphNode,
  MermaidParseError,
  MermaidParseResult,
  MermaidWarning,
} from './types.ts'

/** Directions a header may declare, in diagnostic order. */
const DIRECTIONS: readonly MermaidDirection[] = ['TD', 'LR', 'BT', 'RL']

/** Header keyword a flowchart starts with. */
const HEADER = /^(?:flowchart|graph)/u

/** Statements the subset does not implement, matched as their leading word. */
const UNSUPPORTED_KEYWORDS: readonly string[] = [
  'subgraph',
  'classDef',
  'class',
  'click',
  'style',
  'linkStyle',
  'accTitle',
  'accDescr',
  'direction',
]

/** Node id characters: letters, digits, and underscore. */
const NODE_ID = /^[A-Za-z0-9_]+/u

/** Shape openers and the closer that ends each label. */
const SHAPE_CLOSERS: Readonly<Record<string, string>> = { '[': ']', '(': ')', '{': '}' }

/** Characters that start a link form the subset does not read. */
const OTHER_LINK_OPENER = /^[-=.~]/u

/** A node occurrence inside one statement. */
interface NodeToken {
  /** Mermaid node id. */
  readonly id: string
  /** Label a shape declared; absent for a bare id. */
  readonly label?: string
}

/** A link occurrence inside one statement. */
interface LinkToken {
  /** Label written between the link's pipes; absent for an unlabelled link. */
  readonly label?: string
}

/** Mutable per-node record the parser edits while it merges repeated mentions. */
interface NodeState {
  readonly id: string
  /** Label the node ends up with. */
  label: string
  /** 1-based source line of the first mention. */
  readonly line: number
  /** Whether any mention carried a bracketed label. */
  explicit: boolean
  /** Whether any statement consisted of this node alone. */
  standalone: boolean
}

/** Graph being built for one text. */
interface ParseState {
  readonly nodes: NodeState[]
  readonly byId: Map<string, NodeState>
  readonly edges: MermaidGraphEdge[]
}

/** Read cursor over one statement's characters. */
interface Cursor {
  readonly text: string
  offset: number
}

/**
 * Parse one Mermaid flowchart.
 *
 * The accepted subset is a `flowchart` or `graph` header naming one direction,
 * node statements (`A`, `A[Label]`, `A(Label)`, `A{Label}`), links (`A --> B`,
 * `A -->|Label| B`, `A --- B`) chained in one statement, and `%%` comment lines.
 * Every other statement is refused instead of ignored.
 *
 * @param text - the flowchart source, one statement per line.
 * @returns the graph with its warnings, or the refusal that stopped the parse.
 */
export function parseMermaidFlowchart(text: string): MermaidParseResult {
  const state: ParseState = { nodes: [], byId: new Map(), edges: [] }
  let direction: MermaidDirection | undefined
  for (const [index, source] of text.split(/\r?\n/u).entries()) {
    const line = index + 1
    const statement = source.trim()
    if (statement === '' || statement.startsWith('%%')) continue
    if (direction === undefined) {
      const header = readHeader(statement)
      if (header === undefined) {
        return {
          ok: false,
          error: {
            code: 'mermaid/missing-header',
            message: 'the first statement must be a "flowchart" or "graph" header naming TD, LR, BT, or RL',
            line,
          },
        }
      }
      if ('code' in header) return { ok: false, error: { ...header, line } }
      direction = header.direction
      continue
    }
    const error = readStatement(statement, line, state)
    if (error !== undefined) return { ok: false, error }
  }
  if (direction === undefined) {
    return {
      ok: false,
      error: {
        code: 'mermaid/missing-header',
        message: 'the text declares no "flowchart" or "graph" header',
        line: 1,
      },
    }
  }
  return { ok: true, graph: graphOf(direction, state), warnings: warningsOf(state) }
}

/**
 * Read one header statement.
 * @param statement - trimmed statement text.
 * @returns the declared direction, a refusal, or `undefined` when the statement
 * is not a header at all.
 */
function readHeader(statement: string): { readonly direction: MermaidDirection } | MermaidParseError | undefined {
  if (!HEADER.test(statement)) return undefined
  const rest = statement.replace(HEADER, '').trim()
  const direction = DIRECTIONS.find(candidate => candidate === rest)
  if (direction !== undefined) return { direction }
  return {
    code: 'mermaid/invalid-direction',
    message: rest === ''
      ? 'the header must name a direction: TD, LR, BT, or RL'
      : `unsupported flowchart direction ${JSON.stringify(rest)}; use TD, LR, BT, or RL`,
  }
}

/**
 * Read one node-or-link statement and register everything it declares.
 * @param statement - trimmed statement text.
 * @param line - 1-based source line of the statement.
 * @param state - graph accumulator the statement writes into.
 * @returns the refusal that stops the parse, or `undefined` when it succeeded.
 */
function readStatement(statement: string, line: number, state: ParseState): MermaidParseError | undefined {
  const text = statement.endsWith(';') ? statement.slice(0, -1) : statement
  const keyword = leadingWord(text)
  if (UNSUPPORTED_KEYWORDS.includes(keyword)) {
    return {
      code: 'mermaid/unsupported-syntax',
      message: `unsupported statement "${keyword}"; the importer reads node statements, links, and comments only`,
      line,
    }
  }
  const cursor: Cursor = { text, offset: 0 }
  const first = readNode(cursor)
  if ('code' in first) return { ...first, line }
  const nodes: NodeToken[] = [first]
  const links: LinkToken[] = []
  const edges: MermaidGraphEdge[] = []
  let previous = first.id
  for (;;) {
    skipSpaces(cursor)
    if (cursor.offset >= text.length) break
    const link = readLink(cursor)
    if ('code' in link) return { ...link, line }
    const node = readNode(cursor)
    if ('code' in node) return { ...node, line }
    links.push(link)
    nodes.push(node)
    edges.push({
      from: previous,
      to: node.id,
      ...link.label === undefined ? {} : { label: link.label },
      line,
    })
    previous = node.id
  }
  const standalone = links.length === 0
  for (const node of nodes) {
    const error = declareNode(state, node, line, standalone)
    if (error !== undefined) return error
  }
  state.edges.push(...edges)
  return undefined
}

/**
 * Register one node mention, merging a repeated id and refusing a conflicting label.
 * @param state - graph accumulator receiving the node.
 * @param token - the node occurrence being declared.
 * @param line - 1-based source line of the statement.
 * @param standalone - whether the statement consisted of this node alone.
 * @returns the refusal for a conflicting label, or `undefined`.
 */
function declareNode(
  state: ParseState,
  token: NodeToken,
  line: number,
  standalone: boolean,
): MermaidParseError | undefined {
  const existing = state.byId.get(token.id)
  if (existing === undefined) {
    const node: NodeState = {
      id: token.id,
      label: token.label ?? token.id,
      line,
      explicit: token.label !== undefined,
      standalone,
    }
    state.byId.set(token.id, node)
    state.nodes.push(node)
    return undefined
  }
  if (token.label !== undefined) {
    if (existing.explicit && existing.label !== token.label) {
      return {
        code: 'mermaid/duplicate-node',
        message: `node "${token.id}" already declares the label ${JSON.stringify(existing.label)} on line ${String(existing.line)}`,
        line,
      }
    }
    existing.label = token.label
    existing.explicit = true
  }
  if (standalone) existing.standalone = true
  return undefined
}

/**
 * Read one node occurrence: an id, optionally followed by a shaped label.
 * @param cursor - read cursor, advanced past the node.
 * @returns the node occurrence or the refusal.
 */
function readNode(cursor: Cursor): NodeToken | MermaidParseError {
  skipSpaces(cursor)
  const id = NODE_ID.exec(cursor.text.slice(cursor.offset))?.[0]
  if (id === undefined) {
    return {
      code: 'mermaid/syntax-error',
      message: `expected a node id at column ${String(cursor.offset + 1)}; ids use letters, digits, and underscore`,
    }
  }
  cursor.offset += id.length
  skipSpaces(cursor)
  const opener = cursor.text[cursor.offset]
  const closer = opener === undefined ? undefined : SHAPE_CLOSERS[opener]
  if (closer === undefined) return { id }
  const end = cursor.text.indexOf(closer, cursor.offset + 1)
  if (end < 0) {
    return {
      code: 'mermaid/syntax-error',
      message: `node "${id}" opens its label with "${opener}" but never closes it with "${closer}"`,
    }
  }
  const label = unquote(cursor.text.slice(cursor.offset + 1, end)).trim()
  if (label === '') {
    return { code: 'mermaid/syntax-error', message: `node "${id}" declares an empty label` }
  }
  cursor.offset = end + 1
  return { id, label }
}

/**
 * Read one link: an arrow or a line, plus the optional label between pipes.
 * @param cursor - read cursor, advanced past the link.
 * @returns the link occurrence or the refusal.
 */
function readLink(cursor: Cursor): LinkToken | MermaidParseError {
  skipSpaces(cursor)
  const rest = cursor.text.slice(cursor.offset)
  const arrow = rest.startsWith('-->')
  if (!arrow && !rest.startsWith('---')) {
    if (OTHER_LINK_OPENER.test(rest)) {
      return {
        code: 'mermaid/unsupported-syntax',
        message: `unsupported link ${JSON.stringify(rest.slice(0, 8))}; use "-->", "--->" with a label, or "---"`,
      }
    }
    return {
      code: 'mermaid/syntax-error',
      message: 'expected an arrow "-->" or a line "---" between two nodes',
    }
  }
  cursor.offset += 3
  skipSpaces(cursor)
  if (cursor.text[cursor.offset] !== '|') return {}
  const end = cursor.text.indexOf('|', cursor.offset + 1)
  if (end < 0) {
    return { code: 'mermaid/syntax-error', message: 'a link label opens with "|" but never closes with "|"' }
  }
  const label = unquote(cursor.text.slice(cursor.offset + 1, end)).trim()
  if (label === '') {
    return { code: 'mermaid/syntax-error', message: 'a link label between pipes must not be empty' }
  }
  cursor.offset = end + 1
  return { label }
}

/**
 * Advance the cursor past spaces and tabs.
 * @param cursor - cursor to advance.
 */
function skipSpaces(cursor: Cursor): void {
  while (cursor.text[cursor.offset] === ' ' || cursor.text[cursor.offset] === '\t') cursor.offset += 1
}

/**
 * Read the first whitespace-delimited word of a statement.
 * @param text - trimmed statement text.
 * @returns the leading word, or the whole text when it carries no whitespace.
 */
function leadingWord(text: string): string {
  const space = text.search(/\s/u)
  return space < 0 ? text : text.slice(0, space)
}

/**
 * Strip the double quotes mermaid allows around a label.
 * @param value - raw text between the delimiters.
 * @returns the text without its surrounding quotes.
 */
function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value
}

/**
 * Freeze the accumulator into the exported graph.
 * @param direction - declared layout direction.
 * @param state - accumulator built by the statement pass.
 * @returns the parsed graph in source order.
 */
function graphOf(direction: MermaidDirection, state: ParseState): MermaidFlowchartGraph {
  const nodes: MermaidGraphNode[] = state.nodes.map(node => ({ id: node.id, label: node.label, line: node.line }))
  return { direction, nodes, edges: state.edges }
}

/**
 * Report the nodes the parser created from links alone.
 * @param state - accumulator built by the statement pass.
 * @returns one warning per node that was never declared on its own.
 */
function warningsOf(state: ParseState): MermaidWarning[] {
  const warnings: MermaidWarning[] = []
  for (const node of state.nodes) {
    if (node.explicit || node.standalone) continue
    warnings.push({
      code: 'mermaid/implicit-node',
      message: `node "${node.id}" is only named by links, so it was created with its id as the title`,
    })
  }
  return warnings
}
