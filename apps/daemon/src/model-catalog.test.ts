import { homedir } from 'node:os'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
}))

vi.mock('./claude-cli/query.js', () => ({
  query: queryMock,
}))

import { defaultModelCatalogProvider } from './model-catalog.js'

const catalog = { models: [{ value: 'default', displayName: 'Default', description: 'Default model' }] }

describe('defaultModelCatalogProvider', () => {
  beforeEach(() => {
    queryMock.mockReset()
    queryMock.mockImplementation(() => ({
      initializationResult: vi.fn(async () => catalog),
      close: vi.fn(),
    }))
  })

  it('preserves the complete initialize result and awaits child exit', async () => {
    let finishClose!: () => void
    const closing = new Promise<void>((resolve) => {
      finishClose = resolve
    })
    const result = { ...catalog, commands: [{ name: 'native' }], extra: { capability: true } }
    const close = vi.fn(() => closing)
    queryMock.mockReturnValueOnce({ initializationResult: async () => result, close })
    let settled = false
    const response = defaultModelCatalogProvider('/tmp/project').then((value) => {
      settled = true
      return value
    })
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(settled).toBe(false)
    finishClose()
    await expect(response).resolves.toBe(result)
  })

  it('queries every call without caching', async () => {
    await defaultModelCatalogProvider('/tmp/project')
    await defaultModelCatalogProvider('/tmp/project')

    expect(queryMock).toHaveBeenCalledTimes(2)
    expect(queryMock).toHaveBeenNthCalledWith(1, { prompt: expect.any(Object), options: { cwd: '/tmp/project' } })
    expect(queryMock).toHaveBeenNthCalledWith(2, { prompt: expect.any(Object), options: { cwd: '/tmp/project' } })
  })

  it('uses home as default cwd and closes the query', async () => {
    const close = vi.fn()
    queryMock.mockReturnValueOnce({
      initializationResult: vi.fn(async () => catalog),
      close,
    })

    await defaultModelCatalogProvider()

    expect(queryMock).toHaveBeenCalledWith({ prompt: expect.any(Object), options: { cwd: homedir() } })
    expect(close).toHaveBeenCalledTimes(1)
  })
})
