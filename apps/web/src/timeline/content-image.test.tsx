// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AnonImageContext, decodeContentImage, MarkdownContent, safeDataPreview, ToolResultValue } from './content'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const image = (source: Record<string, unknown>) => ({ type: 'image', source })

describe('safe content block rendering', () => {
  const createObjectURL = vi.fn((_blob: Blob) => 'blob:content-image')
  const revokeObjectURL = vi.fn()

  beforeEach(() => {
    createObjectURL.mockClear()
    revokeObjectURL.mockClear()
    vi.stubGlobal('URL', Object.assign(globalThis.URL, { createObjectURL, revokeObjectURL }))
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    )
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('defers image URL allocation until commit', () => {
    const markup = renderToStaticMarkup(<ToolResultValue value={image({ type: 'base64', media_type: 'image/png', data: png })} />)
    expect(markup).toContain('loading preview')
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('renders a validated base64 raster image and revokes its object URL', async () => {
    const { unmount } = render(<ToolResultValue value={image({ type: 'base64', media_type: 'image/png', data: png })} />)

    const rendered = await screen.findByRole('img', { name: 'Content image' })
    expect(rendered.getAttribute('src')).toBe('blob:content-image')
    expect(createObjectURL).toHaveBeenCalledOnce()
    expect(createObjectURL.mock.calls[0]?.[0]).toBeInstanceOf(Blob)
    expect(document.body.textContent).not.toContain(png)

    unmount()
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:content-image'))
  })

  it('keeps Markdown image output valid inside phrasing elements', () => {
    const markup = renderToStaticMarkup(<MarkdownContent value="[![linked](/tmp/missing.png)](target) and *![emphasized](/tmp/other.png)*" />)
    expect(markup).not.toMatch(/<(?:p|a|em)[^>]*><div/)
    expect(markup).not.toContain('<div')
    expect(markup).not.toContain('<a href="target"')
  })

  it('renders an exactly matched Markdown image with its alt and revokes its object URL', async () => {
    const path = '/tmp/read-shot.png'
    const { unmount } = render(<MarkdownContent value={`![Read preview](${path})`} contentImages={new Map([[path, { mediaType: 'image/png', data: png }]])} />)

    const rendered = await screen.findByRole('img', { name: 'Read preview' })
    expect(rendered.getAttribute('src')).toBe('blob:content-image')
    expect(createObjectURL).toHaveBeenCalledOnce()

    unmount()
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:content-image'))
  })

  it('does not load unmatched local Markdown image paths or match by basename', () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const { rerender } = render(<MarkdownContent value="![missing](/tmp/missing.png)" contentImages={new Map()} />)

    expect(screen.getByText('Preview unavailable · Image: /tmp/missing.png')).toBeTruthy()
    expect(screen.queryByRole('img')).toBeNull()

    rerender(<MarkdownContent value="![wrong path](shot.png)" contentImages={new Map([['/tmp/shot.png', { mediaType: 'image/png', data: png }]])} />)
    expect(screen.getByText('Preview unavailable · Image: shot.png')).toBeTruthy()
    expect(screen.queryByRole('img')).toBeNull()

    rerender(<MarkdownContent value="![file URI](file:///tmp/missing.png)" contentImages={new Map()} />)
    expect(screen.getByText('Preview unavailable · Image: file:///tmp/missing.png')).toBeTruthy()
    expect(screen.queryByRole('img')).toBeNull()
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('anonymous page: auto-loads, or waits for a click when the server asks for confirmation, never showing the path', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 409 } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, blob: async () => new Blob(['image']) } as Response)
    vi.stubGlobal('fetch', fetch)
    render(
      <AnonImageContext.Provider value={(src) => `/api/detail/tok/asset?src=${encodeURIComponent(src)}`}>
        <MarkdownContent value="![shot](/tmp/secret/shot.png)" />
      </AnonImageContext.Provider>,
    )
    const button = await screen.findByRole('button', { name: 'Load image: shot' })
    expect(screen.getByText('Click to load')).toBeTruthy()
    expect(document.body.textContent).not.toContain('/tmp/secret')
    expect(fetch).toHaveBeenCalledWith('/api/detail/tok/asset?src=%2Ftmp%2Fsecret%2Fshot.png', expect.anything())
    fireEvent.click(button)
    expect(await screen.findByRole('img', { name: 'shot' })).toBeTruthy()
    expect(fetch).toHaveBeenLastCalledWith('/api/detail/tok/asset?src=%2Ftmp%2Fsecret%2Fshot.png&confirmed=1', expect.anything())
  })

  it('anonymous page: a failed load shows a generic placeholder without path or reason', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 } as Response))
    render(
      <AnonImageContext.Provider value={(src) => `/api/share/tok/asset?src=${encodeURIComponent(src)}`}>
        <MarkdownContent value="![shot](cotta-asset/0)" />
      </AnonImageContext.Provider>,
    )
    expect(await screen.findByText('Preview unavailable · Image: unavailable')).toBeTruthy()
  })

  it('anonymous page: a scheme-prefixed src (file://) shows the generic placeholder, never the raw path', () => {
    render(
      <AnonImageContext.Provider value={() => null}>
        <MarkdownContent value="![x](file:///home/me/secret.png)" />
      </AnonImageContext.Provider>,
    )
    expect(screen.getByText('Preview unavailable · Image: unavailable')).toBeTruthy()
    expect(document.body.textContent).not.toContain('/home/me/secret')
  })

  const imageResponse = () => ({ ok: true, status: 200, blob: async () => new Blob(['image']) }) as Response
  const imageConfirmation = (canonicalPath: string, ino = '2') => ({ canonicalPath, dev: '1', ino, size: 2 * 1024 * 1024 })

  it.each([
    ['inline', '![local](images/shot.png)'],
    ['reference', '![local][shot]\n\n[shot]: images/shot.png'],
  ])('automatically loads a project-local %s Markdown image with message-bound context', async (_label, value) => {
    const fetch = vi.fn().mockResolvedValue(imageResponse())
    vi.stubGlobal('fetch', fetch)
    render(<MarkdownContent value={value} localImageContext={{ sessionId: 'session/1', messageUuid: 'message/1', projectPath: '/workspace/project', cwd: '/workspace/project/docs' }} />)

    await screen.findByRole('img', { name: 'local' })
    expect(fetch).toHaveBeenCalledWith(
      '/api/sessions/session%2F1/messages/message%2F1/local-image',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ src: 'images/shot.png', confirmedExternal: false, confirmedLarge: false }),
        signal: expect.any(AbortSignal),
      }),
    )
  })

  it('keeps a local image request alive across a Markdown rerender', async () => {
    let resolve!: (response: Response) => void
    const fetch = vi.fn().mockImplementation(() => new Promise<Response>((done) => (resolve = done)))
    vi.stubGlobal('fetch', fetch)
    const props = { localImageContext: { sessionId: 'session', messageUuid: 'message', projectPath: '/workspace/project', cwd: '/workspace/project' } }
    const { rerender } = render(<MarkdownContent value="![local](shot.png)" codeActions {...props} />)

    await waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    rerender(<MarkdownContent value="![local](shot.png)" codeActions={false} {...props} />)
    resolve(imageResponse())

    expect(await screen.findByRole('img', { name: 'local' })).toBeTruthy()
    expect(fetch).toHaveBeenCalledOnce()
  })

  it.each(['/tmp/shot.png', '..%2Foutside%2Fshot.png'])('requires a click for project-external image %s and confirms the server-resolved target', async (src) => {
    const resolvedPath = '/srv/external/shot.png'
    const confirmation = imageConfirmation(resolvedPath)
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: 'image_confirmation_required', size: confirmation.size, external: true, resolvedPath, confirmation }) } as Response)
      .mockResolvedValueOnce(imageResponse())
    vi.stubGlobal('fetch', fetch)
    render(<MarkdownContent value={`![external](${src})`} localImageContext={{ sessionId: 'session', messageUuid: 'message', projectPath: '/workspace/project', cwd: '/workspace/project' }} />)

    const card = screen.getByRole('button', { name: 'Load image: external' })
    expect(document.querySelector('[data-timeline-content="local-image"]')?.getAttribute('data-state')).toBe('external')
    expect(fetch).not.toHaveBeenCalled()
    fireEvent.click(card)
    await screen.findByText('2.0 MiB · Confirm to load')
    expect(screen.getByText(resolvedPath)).toBeTruthy()
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ src, confirmedExternal: false, confirmedLarge: false })

    fireEvent.click(screen.getByRole('button', { name: 'Confirm loading image: external' }))
    await screen.findByRole('img', { name: 'external' })
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({ src, confirmedExternal: true, confirmedLarge: true, expectedConfirmation: confirmation })
  })

  it('uses lexical locality only to probe before confirming a canonical external target', async () => {
    const resolvedPath = '/srv/external/shot.png'
    const confirmation = { ...imageConfirmation(resolvedPath), size: 1024 }
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: 'image_confirmation_required', size: confirmation.size, external: true, resolvedPath, confirmation }) } as Response)
      .mockResolvedValueOnce(imageResponse())
    vi.stubGlobal('fetch', fetch)
    render(<MarkdownContent value="![linked](linked/shot.png)" localImageContext={{ sessionId: 'session', messageUuid: 'message', projectPath: '/workspace/project', cwd: '/workspace/project' }} />)

    await screen.findByText(resolvedPath)
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ src: 'linked/shot.png', confirmedExternal: false, confirmedLarge: false })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm loading image: linked' }))
    await screen.findByRole('img', { name: 'linked' })
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      src: 'linked/shot.png',
      confirmedExternal: true,
      confirmedLarge: true,
      expectedConfirmation: confirmation,
    })
  })

  it('requires reconfirmation when a retry returns a new inspected identity', async () => {
    const first = { ...imageConfirmation('/workspace/project/large.png', '2'), size: 6 * 1024 * 1024 }
    const second = { ...first, ino: '3', size: 7 * 1024 * 1024 }
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: 'image_confirmation_required', size: first.size, external: false, confirmation: first }) } as Response)
      .mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: 'image_confirmation_required', size: second.size, external: false, confirmation: second }) } as Response)
      .mockResolvedValueOnce(imageResponse())
    vi.stubGlobal('fetch', fetch)
    render(<MarkdownContent value="![large](large.png)" localImageContext={{ sessionId: 'session', messageUuid: 'message', projectPath: '/workspace/project', cwd: '/workspace/project' }} />)

    await screen.findByText('6.0 MiB · Confirm to load')
    fireEvent.click(screen.getByRole('button', { name: 'Confirm loading image: large' }))
    await screen.findByText('7.0 MiB · Confirm to load')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      src: 'large.png',
      confirmedExternal: false,
      confirmedLarge: true,
      expectedConfirmation: first,
    })

    fireEvent.click(screen.getByRole('button', { name: 'Confirm loading image: large' }))
    await screen.findByRole('img', { name: 'large' })
    expect(JSON.parse(String(fetch.mock.calls[2]?.[1]?.body))).toEqual({
      src: 'large.png',
      confirmedExternal: false,
      confirmedLarge: true,
      expectedConfirmation: second,
    })
  })

  it('loads a project image destination with query and fragment by its pathname', async () => {
    const fetch = vi.fn().mockResolvedValue(imageResponse())
    vi.stubGlobal('fetch', fetch)
    render(
      <MarkdownContent value="![local](shot.png?v=2#preview)" localImageContext={{ sessionId: 'session', messageUuid: 'message', projectPath: '/workspace/project', cwd: '/workspace/project' }} />,
    )

    await screen.findByRole('img', { name: 'local' })
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ src: 'shot.png?v=2#preview', confirmedExternal: false, confirmedLarge: false })
  })

  it('aborts pending local image requests and revokes loaded Blob URLs', async () => {
    let signal: AbortSignal | undefined
    const fetch = vi.fn((_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>(() => {})
    })
    vi.stubGlobal('fetch', fetch)
    const { unmount } = render(
      <MarkdownContent
        value="![local](/workspace/project/shot.png)"
        localImageContext={{ sessionId: 'session', messageUuid: 'message', projectPath: '/workspace/project', cwd: '/workspace/project' }}
      />,
    )
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    unmount()
    expect(signal?.aborted).toBe(true)

    fetch.mockResolvedValueOnce(imageResponse())
    const loaded = render(
      <MarkdownContent
        value="![local](/workspace/project/shot.png)"
        localImageContext={{ sessionId: 'session', messageUuid: 'message-2', projectPath: '/workspace/project', cwd: '/workspace/project' }}
      />,
    )
    await screen.findByRole('img', { name: 'local' })
    loaded.unmount()
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:content-image'))
  })

  it('resets local image state when its source changes', async () => {
    const fetch = vi.fn().mockResolvedValue(imageResponse())
    vi.stubGlobal('fetch', fetch)
    const { rerender } = render(
      <MarkdownContent
        value="![first](/workspace/project/first.png)"
        localImageContext={{ sessionId: 'session', messageUuid: 'message-1', projectPath: '/workspace/project', cwd: '/workspace/project' }}
      />,
    )
    await screen.findByRole('img', { name: 'first' })

    rerender(
      <MarkdownContent
        value="![second](/workspace/project/second.png)"
        localImageContext={{ sessionId: 'session', messageUuid: 'message-2', projectPath: '/workspace/project', cwd: '/workspace/project' }}
      />,
    )

    await screen.findByRole('img', { name: 'second' })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:content-image')
  })

  it('retries local image errors from an alt-labelled control', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ error: 'image_not_found' }) } as Response)
      .mockResolvedValueOnce(imageResponse())
    vi.stubGlobal('fetch', fetch)
    render(
      <MarkdownContent
        value="![missing](/workspace/project/missing.png)"
        localImageContext={{ sessionId: 'session', messageUuid: 'message', projectPath: '/workspace/project', cwd: '/workspace/project' }}
      />,
    )

    expect((await screen.findByRole('alert')).textContent).toContain('image_not_found')
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading image: missing' }))
    expect(await screen.findByRole('img', { name: 'missing' })).toBeTruthy()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('shows oversized images as a non-retryable terminal error', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 413, json: async () => ({ error: 'file_too_large', size: 26 * 1024 * 1024 }) } as Response)
    vi.stubGlobal('fetch', fetch)
    render(
      <MarkdownContent
        value="![oversized](/workspace/project/large.png)"
        localImageContext={{ sessionId: 'session', messageUuid: 'message', projectPath: '/workspace/project', cwd: '/workspace/project' }}
      />,
    )

    expect((await screen.findByRole('alert')).textContent).toBe('Image is too large (26.0 MiB; maximum 25 MiB)')
    expect(screen.queryByRole('button', { name: /oversized/ })).toBeNull()
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('leaves remote Markdown images to the browser', () => {
    render(<MarkdownContent value="![remote](https://images.example/shot.png)" />)

    expect(screen.getByRole('img', { name: 'remote' }).getAttribute('src')).toBe('https://images.example/shot.png')
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('shows an unavailable state when browser image decoding fails', async () => {
    render(<ToolResultValue value={image({ type: 'base64', media_type: 'image/png', data: png })} />)
    const rendered = await screen.findByRole('img', { name: 'Content image' })
    rendered.dispatchEvent(new Event('error'))
    expect(await screen.findByText('Preview unavailable · Image: browser could not decode image')).toBeTruthy()
    expect(screen.queryByRole('img', { name: 'Content image' })).toBeNull()
  })

  it('rejects invalid, unsupported, and oversized base64 without creating object URLs', () => {
    const { rerender } = render(<ToolResultValue value={image({ type: 'base64', media_type: 'image/png', data: 'bm90IGEgcG5n' })} />)
    expect(screen.getByText(/signature does not match/)).toBeTruthy()

    rerender(<ToolResultValue value={image({ type: 'base64', media_type: 'image/svg+xml', data: 'PHN2Zz4=' })} />)
    expect(screen.getByText(/unsupported image type/)).toBeTruthy()

    for (const mediaType of [undefined, 'image/x-png', 'image/jpg', 'image/pjpeg']) expect(decodeContentImage(png, mediaType)).toEqual({ error: 'unsupported image type' })

    rerender(<ToolResultValue value={image({ type: 'base64', media_type: 'image/png', data: 'A'.repeat(6_990_508) })} />)
    expect(screen.getByText(/exceeds 5 MiB/)).toBeTruthy()
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('PHN2Zz4=')
  })

  it('shows document metadata with its source content', () => {
    render(<ToolResultValue value={{ type: 'document', title: 'Quarterly report', context: 'Finance context', source: { type: 'text', data: 'Document body' } }} />)

    expect(screen.getByText('Quarterly report')).toBeTruthy()
    expect(screen.getByText('Finance context')).toBeTruthy()
    expect(screen.getByText('Document body')).toBeTruthy()
  })

  it('shows URL and file metadata without loading either source', () => {
    const { rerender } = render(<ToolResultValue value={image({ type: 'url', url: 'https://images.example/path.png' })} />)
    const link = screen.getByRole('link', { name: 'images.example' })
    expect(link.getAttribute('href')).toBe('https://images.example/path.png')
    expect(screen.queryByRole('img')).toBeNull()

    rerender(<ToolResultValue value={image({ type: 'file', file_id: 'file_123' })} />)
    expect(screen.getByText(/file_123/)).toBeTruthy()
    expect(screen.queryByRole('img')).toBeNull()

    rerender(<ToolResultValue value={image({ type: 'file', file_id: '' })} />)
    expect(screen.getByText('Preview unavailable · Image: missing file_id')).toBeTruthy()

    rerender(<ToolResultValue value={{ type: 'file', filename: 'report.txt', mime_type: 'text/plain', file_id: 'file_456' }} />)
    expect(screen.getByText(/report\.txt · text\/plain · file_456/)).toBeTruthy()
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('redacts nested and flat image base64 data without mutation or DOM disclosure', async () => {
    const value = { content: [{ type: 'text', text: 'before' }, image({ type: 'base64', media_type: 'image/png', data: png }), { type: 'text', text: 'after' }] }
    expect(safeDataPreview(value)).not.toContain(png)
    expect(safeDataPreview({ toolUseResult: { type: 'image', file: { type: 'image/png', base64: png } } })).not.toContain(png)
    expect(safeDataPreview({ type: 'image', mimeType: 'image/png', data: png })).not.toContain(png)
    expect(safeDataPreview({ type: 'image', media_type: 'image/png', data: png })).not.toContain(png)
    expect((value.content[1] as ReturnType<typeof image>).source.data).toBe(png)

    render(<ToolResultValue value={value.content} />)
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce())
    expect(document.body.textContent).toContain('before')
    expect(document.body.textContent).toContain('after')
    expect(document.body.textContent).not.toContain(png)
  })

  it('balances committed Blob URLs under StrictMode', async () => {
    const { unmount } = render(
      <StrictMode>
        <ToolResultValue value={image({ type: 'base64', media_type: 'image/png', data: png })} />
      </StrictMode>,
    )

    await screen.findByRole('img', { name: 'Content image' })
    unmount()
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledTimes(createObjectURL.mock.calls.length))
  })
})
