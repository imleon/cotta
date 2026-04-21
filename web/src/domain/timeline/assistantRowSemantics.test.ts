import { describe, expect, it } from 'vitest'
import { extractThinkingSubtitle, THINKING_ROW_TITLE } from './assistantRowSemantics'

describe('assistantRowSemantics', () => {
  it('uses the shared thinking row title', () => {
    expect(THINKING_ROW_TITLE).toBe('思考')
  })

  it('extracts subtitle from a markdown heading', () => {
    expect(extractThinkingSubtitle('## 规划方案\n\n详细内容')).toBe('规划方案')
  })

  it('extracts subtitle from a leading bold block', () => {
    expect(extractThinkingSubtitle('**关键判断**\n后续分析')).toBe('关键判断')
  })

  it('returns empty when there is no heading or leading bold marker', () => {
    expect(extractThinkingSubtitle('这是一段普通思考，没有标题')).toBe('')
  })
})
