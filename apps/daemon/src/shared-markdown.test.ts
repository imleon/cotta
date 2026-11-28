import { localImageDestinationPathname, projectTurnMarkdown, turnExportFilename, unwrapMarkdownPayloadFences } from '@cotta/shared'
import { describe, expect, it } from 'vitest'

const userMsg = (text: string) => ({ type: 'user', uuid: 'u', session_id: 's', message: { role: 'user', content: text } })
const assistantText = (text: string) => ({ type: 'assistant', uuid: 'a', session_id: 's', message: { role: 'assistant', content: [{ type: 'text', text }] } })

describe('shared Markdown helpers', () => {
  it('unwraps only nested Markdown payload fences', () => {
    expect(unwrapMarkdownPayloadFences(['```md', '![image](shot.png)', '```text', 'nested', '```', '```'].join('\n'))).toBe(['![image](shot.png)', '```text', 'nested', '```'].join('\n'))
    expect(unwrapMarkdownPayloadFences(['```md', '![image](shot.png)', '```'].join('\n'))).toBe(['```md', '![image](shot.png)', '```'].join('\n'))
  })

  it('extracts and decodes local destination pathnames', () => {
    expect(localImageDestinationPathname('image.png?v=2#preview')).toBe('image.png')
    expect(localImageDestinationPathname('image%3Fname.png?v=2')).toBe('image?name.png')
    expect(localImageDestinationPathname('..%2Fexternal%2Fimage.png')).toBe('../external/image.png')
    expect(localImageDestinationPathname('invalid%zz.png')).toBeNull()
  })

  it('projects only user/assistant conversation text in timeline order', () => {
    const turn = {
      primaryUserUuid: 'u',
      messages: [
        userMsg('Hello'),
        {
          type: 'assistant',
          uuid: 't',
          session_id: 's',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'secret' },
              { type: 'text', text: 'Hi there' },
              { type: 'tool_use', name: 'Bash', input: {} },
            ],
          },
        },
        { type: 'user', uuid: 'r', session_id: 's', message: { role: 'user', content: [{ type: 'tool_result', content: 'output' }] } },
        assistantText('Done'),
      ],
    } as never
    expect(projectTurnMarkdown(turn)).toBe('Hello\n\nHi there\n\nDone')
  })

  it('keeps remote images, drops local images', () => {
    const turn = { primaryUserUuid: 'u', messages: [assistantText('![a](https://x.com/i.png) and ![b](./local.png) end')] } as never
    const md = projectTurnMarkdown(turn)
    expect(md).toContain('https://x.com/i.png')
    expect(md).not.toContain('local.png')
  })

  it('formats UTC export filename', () => {
    expect(turnExportFilename({ primaryUserUuid: 'u', primaryUserTimestampMs: Date.parse('2026-01-02T03:04:05.678Z'), messages: [] } as never)).toBe('turn-20260102T030405Z')
  })
})
