import { describe, expect, it } from 'vitest'
import { modelIconKind } from './turn-option-controls'

describe('modelIconKind', () => {
  it('maps gpt family to gpt', () => {
    expect(modelIconKind('claude-gpt-6-1-sol-max[1m]')).toBe('gpt')
    expect(modelIconKind('claude-gpt-5-5-max')).toBe('gpt')
  })
  it('maps openrouter and anthropic families to anthropic (version-independent)', () => {
    expect(modelIconKind('claude-openrouter-4o-max[1m]')).toBe('anthropic')
    expect(modelIconKind('claude-openrouter-3o-max[1m]')).toBe('anthropic')
    expect(modelIconKind('opus')).toBe('anthropic')
    expect(modelIconKind('claude-sonnet-5-5')).toBe('anthropic')
  })
  it('maps doubao family to doubao', () => {
    expect(modelIconKind('claude-doubao-seed-evolving-dev[1m]')).toBe('doubao')
  })
  it('maps deepseek family to deepseek', () => {
    expect(modelIconKind('claude-deepseek-v4-1-flash-max[1m]')).toBe('deepseek')
  })
  it('falls back to generic for unknown providers', () => {
    expect(modelIconKind('claude-mystery-model')).toBe('generic')
  })
})
