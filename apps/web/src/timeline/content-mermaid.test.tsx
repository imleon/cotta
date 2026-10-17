// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react'
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

  it('keeps the previous diagram visible while new code renders', async () => {
    const { container, rerender } = render(<MarkdownContent value={fence} />)
    await waitFor(() => expect(container.querySelector('.markdown-mermaid svg')).not.toBeNull())
    rerender(<MarkdownContent value={'```mermaid\nflowchart LR\n  A --> C\n```'} />)
    expect(container.querySelector('.markdown-mermaid svg')).not.toBeNull()
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
