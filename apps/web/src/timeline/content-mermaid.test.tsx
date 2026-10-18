// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownContent } from './content'

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async (id: string) => ({ svg: `<svg data-id="${id}"><text>rendered</text></svg>` })),
  },
}))

afterEach(cleanup)

const fence = '```mermaid\nflowchart LR\n  A --> B\n```'

describe('mermaid markdown rendering', () => {
  it('renders a ```mermaid block as inline SVG, not a shiki code block', async () => {
    const { container } = render(<MarkdownContent value={fence} />)
    await waitFor(() => expect(container.querySelector('.markdown-mermaid svg')).not.toBeNull())
    expect(container.querySelector('.markdown-code-block')).toBeNull()
  })

  it('suppresses mermaid error rendering so failed renders leave no nodes on document.body', async () => {
    const mermaid = (await import('mermaid')).default
    render(<MarkdownContent value={fence} />)
    await waitFor(() => expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({ suppressErrorRendering: true })))
  })

  it('falls back to the code block when the first render fails', async () => {
    const mermaid = (await import('mermaid')).default
    vi.mocked(mermaid.render).mockRejectedValueOnce(new Error('parse error'))
    const { container } = render(<MarkdownContent value={'```mermaid\nflowchart LR\n  A -->\n```'} />)
    await act(async () => {})
    expect(container.querySelector('.markdown-mermaid')).toBeNull()
    expect(container.querySelector('.markdown-code-block')).not.toBeNull()
  })

  it('keeps the previous diagram when a later (half-streamed) render fails', async () => {
    const mermaid = (await import('mermaid')).default
    const { container, rerender } = render(<MarkdownContent value={fence} />)
    await waitFor(() => expect(container.querySelector('.markdown-mermaid svg')).not.toBeNull())
    vi.mocked(mermaid.render).mockRejectedValueOnce(new Error('parse error'))
    rerender(<MarkdownContent value={'```mermaid\nflowchart LR\n  A --> B\n  B -->\n```'} />)
    await act(async () => {})
    expect(mermaid.render).toHaveBeenLastCalledWith(expect.any(String), 'flowchart LR\n  A --> B\n  B -->')
    expect(container.querySelector('.markdown-mermaid svg')).not.toBeNull()
    expect(container.querySelector('.markdown-code-block')).toBeNull()
  })

  it('renders without crypto.randomUUID (non-secure context)', async () => {
    vi.stubGlobal('crypto', {})
    try {
      const { container } = render(<MarkdownContent value={fence} />)
      await waitFor(() => expect(container.querySelector('.markdown-mermaid svg')).not.toBeNull())
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
