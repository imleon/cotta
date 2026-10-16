import { homedir } from 'node:os'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
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
