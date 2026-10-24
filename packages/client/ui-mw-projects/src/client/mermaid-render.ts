/**
 * Mermaid rendering for the workflow canvas.
 *
 * Mermaid is a large dependency the panel needs only once a project with a
 * stored definition is open, so it arrives through a dynamic `import()` that the
 * client bundle emits as its own chunk. The render itself runs with
 * `securityLevel: 'strict'` and HTML labels off: a definition title is user text
 * that must never become markup, and `strict` also removes the `click`
 * directive, so the canvas binds its own listeners on the returned SVG.
 */

/** Theme tokens the diagram draws with, and the colors used before styles apply. */
const THEME_TOKENS = {
  primaryColor: ['--dsw-alias-bg-layer-2', '#ffffff'],
  primaryTextColor: ['--dsw-alias-label-primary', '#1f1f1f'],
  primaryBorderColor: ['--dsw-alias-border-l4', '#9aa0a6'],
  secondaryColor: ['--dsw-alias-bg-layer-2', '#ffffff'],
  tertiaryColor: ['--dsw-alias-bg-layer-1', '#f7f8fa'],
  lineColor: ['--dsw-alias-border-l4', '#9aa0a6'],
  textColor: ['--dsw-alias-label-primary', '#1f1f1f'],
  edgeLabelBackground: ['--dsw-alias-bg-base', '#ffffff'],
} as const satisfies Record<string, readonly [string, string]>

/**
 * Resolve one theme token to the color the document currently paints with.
 *
 * Mermaid's color parser reads literal colors and rejects a `var()` reference,
 * so the tokens are resolved here rather than handed over as custom properties.
 * @param token - custom property name, including its leading `--`.
 * @param fallback - color used when the property is unset (no stylesheet yet).
 * @returns the resolved color, or the fallback.
 */
function themeColor(token: string, fallback: string): string {
  const resolved = getComputedStyle(document.body).getPropertyValue(token).trim()
  return resolved === '' ? fallback : resolved
}

/**
 * Mermaid's styling for the canvas: no start-on-load sweep, strict security,
 * plain-text labels, and theme colors resolved from the active `--dsw-*` tokens
 * so the diagram follows light and dark.
 */
function mermaidConfig(): Record<string, unknown> {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    fontFamily: 'var(--dsw-font-family)',
    fontSize: 13,
    flowchart: { htmlLabels: false, curve: 'basis', padding: 12, nodeSpacing: 32, rankSpacing: 44 },
    themeVariables: Object.fromEntries(Object.entries(THEME_TOKENS)
      .map(([name, [token, fallback]]) => [name, themeColor(token, fallback)])),
  }
}

/** One flowchart render attempt. */
export type FlowchartRender =
  | { readonly ok: true; readonly svg: string }
  | { readonly ok: false; readonly message: string }

/**
 * Render one flowchart source to SVG.
 * @param id - unique element id Mermaid builds the diagram's own ids from.
 * @param text - flowchart source the graph module generated.
 * @returns the SVG, or the reason Mermaid refused the source. A refused render
 * never rejects: the canvas shows the reason beside the source text.
 */
export async function renderFlowchart(id: string, text: string): Promise<FlowchartRender> {
  try {
    const { default: mermaid } = await import('mermaid')
    mermaid.initialize(mermaidConfig())
    const rendered = await mermaid.render(id, text)
    return { ok: true, svg: rendered.svg }
  } catch (error: unknown) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
