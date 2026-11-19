import type { Nodes } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { describe, expect, it } from 'vitest'
import { splitLarkMarkdown } from './lark-markdown.js'

function split(content: string): string[] {
  const parts = splitLarkMarkdown(content)
  function check(node: Nodes, inList = false) {
    expect(node.type === 'blockquote' && inList).toBe(false)
    if ('children' in node) for (const child of node.children) check(child, inList || node.type === 'list')
  }
  for (const part of parts) check(fromMarkdown(part))
  return parts.map((part) => part.trim())
}

describe('splitLarkMarkdown', () => {
  it('preserves 3000 top-level nested quotes without overflowing the stack', () => {
    const content = `${'> '.repeat(3000)}text`
    expect(splitLarkMarkdown(content)).toEqual([content])
  }, 30000)

  it('traverses 3000 nested quotes inside a list without overflowing the stack', () => {
    const quoted = `${'> '.repeat(3000)}text`
    expect(splitLarkMarkdown(`1. ${quoted}`)).toEqual(['1.', quoted])
  }, 30000)

  it('splits a list inside 256 enclosing quotes without changing order or quote depth', () => {
    // Keep repeated parsing bounded here; the two traversal-only paths above cover 3000 levels.
    const prefix = '> '.repeat(256)
    expect(splitLarkMarkdown(`${prefix}1. > text`)).toEqual([`${prefix}1.`, `${prefix}> text`])
  }, 30000)

  it('emits quoted sibling splits in source order while grouping adjacent items', () => {
    const content = 'before\n\n> 1. first\n> 1. > one\n> 1. middle\n> 1. > two\n> 1. last\n\nafter'
    expect(splitLarkMarkdown(content)).toEqual(['before\n\n', '> 1. first\n> 2.', '> > one', '> 3. middle\n> 4.', '> > two', '> 5. last', '\n\nafter'])
  })

  it('resolves earlier references using the first definition in left-to-right preorder', () => {
    const content = '1. > [before][id]\n\n> [id]: /first "first"\n\n[id]: /second\n\n2. > [after][id]\n\n> [id]: /third'
    expect(splitLarkMarkdown(content)).toEqual(['1.', '> [before](</first> "first")', '\n\n> [id]: /first "first"\n\n[id]: /second\n\n', '2.', '> [after](</first> "first")', '\n\n> [id]: /third'])
  })

  it.each([
    '',
    ' \r\nplain text  \r\n',
    '1. 前文\n\n   ',
    'before\n\n> top quote\n> next line\n\nafter',
    '> [reference][id]\n\n[id]: /target',
    '1. ordinary\n1. repeated number\n\n- nested\n  - list',
    '1. `> inline` and \\> escaped\n\n   ```md\n   > fenced\n   ```\n\n       > indented code',
  ])('preserves the exact source when no quote has a list ancestor: %s', (content) => {
    expect(splitLarkMarkdown(content)).toEqual([content])
  })

  it('splits before text, quote, unnumbered continuation and following item', () => {
    expect(split('1. 前文\n\n   > quote\n\n   续文\n\n2. 下一项')).toEqual(['1. 前文', '> quote', '续文', '2. 下一项'])
  })

  it('continues ordered numbering from the list start, not repeated source markers', () => {
    expect(split('7. first\n   > one\n1. second\n   > two\n1. third')).toEqual(['7. first', '> one', '8. second', '> two', '9. third'])
  })

  it('retains consecutive quotes and same-item continuation in source order', () => {
    expect(split('- first\n  > one\n\n  middle\n\n  > two\n\n  end\n- second')).toEqual(['- first', '> one', 'middle', '> two', 'end', '- second'])
  })

  it('preserves multiline lazy continuation and CRLF', () => {
    expect(split('1. first\r\n   > quoted\r\nlazy\r\n   > next  \r\n   > last\r\n\r\n   after\r\n1. end')).toEqual(['1. first', '> quoted\r\nlazy\r\n> next  \r\n> last', 'after', '2. end'])
  })

  it('preserves nested quotes and code inside a lifted quote', () => {
    expect(split('1. first\n   > outer\n   > > inner\n   >\n   > ```md\n   >   > literal\n   > ```\n1. next')).toEqual(['1. first', '> outer\n> > inner\n>\n> ```md\n>   > literal\n> ```', '2. next'])
  })

  it('lifts affected nested lists but preserves unrelated nested lists', () => {
    expect(split('1. parent\n   - untouched\n     - child\n\n   3. nested\n      > quote\n   1. nested next\n1. end')).toEqual([
      '1. parent\n   - untouched\n     - child',
      '3. nested',
      '> quote',
      '4. nested next',
      '2. end',
    ])
  })

  it('also removes list ancestry inside an enclosing blockquote', () => {
    expect(split('> outer\n>\n> 1. first\n>    > inner\n> 1. next')).toEqual(['> outer\n> \n>', '> 1. first\n>', '> > inner', '> 2. next'])
  })

  it('handles alternating nested quote and list containers', () => {
    const content = '1. parent\n   > outer\n   > - child\n   >   > inner\n   >   > - leaf\n   >   >   > deepest\n1. next'
    const result = split(content)
    expect(result.join('\n')).toContain('deepest')
    expect(result.at(-1)).toBe('2. next')
  })

  it('preserves indentation of code outside the quote within the affected item', () => {
    expect(split('1. before\n\n       > code\n\n   > actual quote\n\n       > after code\n1. next')).toEqual(['1. before\n\n       > code', '> actual quote', '> after code', '2. next'])
    const parts = splitLarkMarkdown('1. before\n   > actual quote\n\n       > code')
    expect(fromMarkdown(parts.at(-1)!).children[0]).toMatchObject({ type: 'code', value: '> code' })
  })

  it('preserves unaffected document regions byte-for-byte', () => {
    const before = '# heading\r\n\r\n```md\r\n1. > literal\r\n```\r\n\r\n'
    const after = '\r\n\r\n> original top-level\r\n\r\n    > code\r\n'
    const parts = splitLarkMarkdown(`${before}1. first\r\n   > lifted\r\n1. next${after}`)
    expect(parts[0]).toBe(before)
    expect(parts.at(-1)).toBe(after)
  })

  it('handles items starting directly with a quote without inventing text', () => {
    expect(split('1. > quote\n1. next')).toEqual(['1.', '> quote', '2. next'])
    expect(fromMarkdown(splitLarkMarkdown('1. > quote')[0]).children[0]).toMatchObject({ type: 'list', ordered: true, start: 1 })
  })

  it('keeps cross-element link and image references resolvable with original definitions', () => {
    const content = '1. before\n\n   > [reference][id] and ![image][] and [shortcut]\n\n   after\n\n[id]: https://example.com\n[image]: image.png "title"\n[shortcut]: /shortcut\n[unused]: /unused'
    const parts = splitLarkMarkdown(content)
    expect(parts[1]).toBe('> [reference](<https://example.com>) and ![image](<image.png> "title") and [shortcut](</shortcut>)')
    expect(parts[0].trim()).toBe('1. before')
    expect(parts[2].trim()).toBe('after')
    expect(parts[1]).not.toContain('[unused]:')
    const quote = fromMarkdown(parts[1]).children[0]
    expect(quote).toMatchObject({
      type: 'blockquote',
      children: [{ children: [{ type: 'link' }, { type: 'text' }, { type: 'image' }, { type: 'text' }, { type: 'link' }] }],
    })
  })

  it('preserves multiline definitions inside containers and the first duplicate definition', () => {
    const content = '1. first\n   > [link][id]\n\n   [id]:\n     https://example.com\n     "title"\n\n[id]: /ignored'
    const parts = splitLarkMarkdown(content)
    expect(parts[1]).toBe('> [link](<https://example.com> "title")')
    expect(fromMarkdown(parts[1]).children[0]).toMatchObject({ type: 'blockquote', children: [{ children: [{ type: 'link', url: 'https://example.com', title: 'title' }] }] })
  })

  it('keeps the global first definition even when a later fragment redefines it', () => {
    const parts = splitLarkMarkdown('[id]: /correct\n\n1. item\n   > quote\n\nText [id]\n\n[id]: /wrong')
    expect(parts.at(-1)).toContain('Text [id](</correct>)')
    expect(parts.at(-1)).toContain('[id]: /wrong')
  })

  it('resolves references before an unfinished code fence without appended context', () => {
    const parts = splitLarkMarkdown('[id]: /target\n\n1. item\n   > quote\n\n[link][id]\n\n```text\nunfinished')
    expect(parts.at(-1)).toContain('[link](</target>)\n\n```text\nunfinished')
  })

  it('retains resolved links when a long fragment is prefix-truncated', () => {
    const parts = splitLarkMarkdown(`[id]: /target\n\n1. before\n   > [link][id] ${'x'.repeat(40000)}`)
    const truncated = parts.at(-1)!.slice(0, 500)
    expect(fromMarkdown(truncated).children[0]).toMatchObject({ type: 'blockquote', children: [{ children: [{ type: 'link', url: '/target' }, { type: 'text' }] }] })
  })

  it('preserves multiline labels and does not rewrite escaped or code references', () => {
    const parts = splitLarkMarkdown('1. before\n   > [**multi**\n   > line][id], \\[id], `[id]`\n\n[id]: /target')
    expect(parts[1]).toBe('> [**multi**\n> line](</target>), \\[id], `[id]`')
  })

  it('keeps nested image labels and safely encodes decoded URLs and titles', () => {
    const source = '1. before\n   > [**link** ![image][im]][id]\n\n[id]: <https://example.com/a&#62;b&#92;c?x=&amp;y> "a &quot;title&quot; &amp; &#92; &#10; end"\n[im]: <a&#60;b.png>'
    const parts = splitLarkMarkdown(source)
    const link = fromMarkdown(parts[1]).children[0]
    expect(link).toMatchObject({
      type: 'blockquote',
      children: [
        { children: [{ type: 'link', url: 'https://example.com/a>b\\c?x=&y', title: 'a "title" & \\ \n end', children: [{ type: 'strong' }, { type: 'text' }, { type: 'image', url: 'a<b.png' }] }] },
      ],
    })
  })

  it.each(['- ', '1. ', '9. '])('preserves code spaces when a tab is only partly consumed by %s', (marker) => {
    const content = `${marker}before\n\t> quote\n\n\t    code\n\n\t> last`
    function values(node: Nodes): string[] {
      if ('children' in node) return node.children.flatMap(values)
      return 'value' in node ? [node.value] : []
    }
    expect(splitLarkMarkdown(content).flatMap((part) => values(fromMarkdown(part)))).toEqual(values(fromMarkdown(content)))
    split(content)
  })

  it.each(['   \tafter', '\t\tcode', '   \t\tcode', '       \tcode\tvalue'])('preserves paragraph/code meaning when moving original-column tabs: %j', (continuation) => {
    const content = `1. before\n   > quote\n\n${continuation}`
    function blocks(node: Nodes): Array<{ type: string; value: string }> {
      if (node.type === 'code') return [{ type: node.type, value: node.value }]
      if (node.type === 'paragraph') return [{ type: node.type, value: node.children.map((child) => ('value' in child ? child.value : '')).join('') }]
      return 'children' in node ? node.children.flatMap(blocks) : []
    }
    expect(splitLarkMarkdown(content).flatMap((part) => blocks(fromMarkdown(part)))).toEqual(blocks(fromMarkdown(content)))
  })

  it('preserves normalized syntax indentation when adding wider ordered markers back', () => {
    const content = '9. first\n\n   \tafter\n\n       \tcode\tvalue\n1. before\n   > quote\n1. next\n\n   \tmore\n\n       \tcode\tvalue'
    const parts = splitLarkMarkdown(content)
    expect(parts).toHaveLength(3)
    expect(fromMarkdown(parts[2]).children[0]).toMatchObject({
      type: 'list',
      start: 11,
      children: [{ children: [{ type: 'paragraph' }, { type: 'paragraph', children: [{ value: 'more' }] }, { type: 'code', value: '\tcode\tvalue' }] }],
    })
  })

  it('keeps fenced code payload tabs and nested lists when grouping ordinary items', () => {
    const parts = splitLarkMarkdown('9. first\n   - nested-a\n   - nested-b\n\n   ```txt\n   \t\tpayload\tend\n   ```\n1. before\n   > quote\n1. next\n   - nested-c\n   - nested-d')
    expect(parts).toHaveLength(3)
    expect(fromMarkdown(parts[0]).children[0]).toMatchObject({
      type: 'list',
      start: 9,
      children: [{ children: [{ type: 'paragraph' }, { type: 'list', children: [{}, {}] }, { type: 'code', value: '\t\tpayload\tend' }] }, { type: 'listItem' }],
    })
    expect(fromMarkdown(parts[2]).children[0]).toMatchObject({ type: 'list', start: 11, children: [{ children: [{ type: 'paragraph' }, { type: 'list', children: [{}, {}] }] }] })
  })

  it('keeps 200 ordinary items and the final quote item prefix in a single list fragment', () => {
    const content = `${Array.from({ length: 200 }, (_, i) => `1. item-${i}`).join('\n')}\n   > quote`
    const parts = splitLarkMarkdown(content)
    expect(parts).toHaveLength(2)
    expect(fromMarkdown(parts[0]).children[0]).toMatchObject({ type: 'list', start: 1, children: Array.from({ length: 200 }, () => ({ type: 'listItem' })) })
    expect(parts[0]).toContain('200. item-199')
    expect(parts[1]).toBe('> quote')
  })

  it('keeps initially indented sibling items at the same list level', () => {
    const parts = splitLarkMarkdown('  - first\n  - before\n    > quote')
    expect(parts).toHaveLength(2)
    expect(fromMarkdown(parts[0]).children[0]).toMatchObject({ type: 'list', children: [{ children: [{ type: 'paragraph' }] }, { children: [{ type: 'paragraph' }] }] })
  })

  it('groups only adjacent list items across CRLF loose and empty-item separators', () => {
    const parts = splitLarkMarkdown('8. first\r\n\r\n1.\r\n\r\n1. before\r\n   > quote\r\n\r\n   after\r\n\r\n1. fourth\r\n\r\n1. fifth')
    expect(parts.map((part) => part.trim())).toEqual(['8. first\r\n\r\n9.\r\n\r\n10. before', '> quote', 'after', '11. fourth\r\n\r\n12. fifth'])
    expect(fromMarkdown(parts[0]).children[0]).toMatchObject({ type: 'list', spread: true, children: [{}, { children: [] }, {}] })
  })

  it('accepts every partial prefix of streamed nested-list Markdown', () => {
    const content = '1. 前文\n\n   > outer\n   > - nested\n   >   > quote\n\n   续文\n\n   '
    for (let length = 0; length <= content.length; length++) split(content.slice(0, length))
  })

  it('handles optional list indentation and tabs without dropping text', () => {
    expect(split('  1. first\n     > quote\n  1. next')).toEqual(['1. first', '> quote', '2. next'])
    expect(split('1.\tfirst\n\t> quote\n1.\tnext')).toEqual(['1. first', '> quote', '2. next'])
  })
})
