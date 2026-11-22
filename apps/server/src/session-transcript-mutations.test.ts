import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deleteSessionTranscript, forkSessionTranscript, renameSessionTranscript, SessionTranscriptMutationError } from './session-transcript-mutations.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture(entries: unknown[] = []) {
  const directory = await mkdtemp(join(tmpdir(), 'cotta-session-mutations-'))
  directories.push(directory)
  const sessionId = randomUUID()
  const transcriptPath = join(directory, `${sessionId}.jsonl`)
  const write = (records: unknown[]) => writeFile(transcriptPath, `${records.map((entry) => JSON.stringify(entry)).join('\n')}\n`)
  await write(entries)
  return { directory, sessionId, transcriptPath, write }
}

async function records(path: string): Promise<Array<Record<string, unknown> & { uuid: string }>> {
  return (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}

describe('session transcript mutations', () => {
  it('appends a native custom title without rewriting source bytes', async () => {
    const source = await fixture([{ type: 'user', uuid: randomUUID(), message: { content: 'hello' } }])
    const before = await readFile(source.transcriptPath, 'utf8')
    await renameSessionTranscript(source, source.sessionId, '  New title  ')
    await renameSessionTranscript(source, source.sessionId, 'Last title')
    expect(await readFile(source.transcriptPath, 'utf8')).toBe(
      `${before}${JSON.stringify({ type: 'custom-title', customTitle: 'New title', sessionId: source.sessionId })}\n${JSON.stringify({ type: 'custom-title', customTitle: 'Last title', sessionId: source.sessionId })}\n`,
    )
  })

  it('does not recreate a deleted source, rename an empty stub, or follow a symlink', async () => {
    const source = await fixture()
    await rm(source.transcriptPath)
    await expect(renameSessionTranscript(source, source.sessionId, 'Title')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(source.directory)).toEqual([])
    await writeFile(source.transcriptPath, '')
    await expect(renameSessionTranscript(source, source.sessionId, 'Title')).rejects.toThrow('nonempty')
    expect(await readFile(source.transcriptPath, 'utf8')).toBe('')
    await rm(source.transcriptPath)
    const real = join(source.directory, 'real.jsonl')
    await writeFile(real, '{}\n')
    await symlink(real, source.transcriptPath)
    await expect(renameSessionTranscript(source, source.sessionId, 'Title')).rejects.toThrow()
    expect(await readFile(real, 'utf8')).toBe('{}\n')
  })

  it.each(['rename', 'fork', 'delete'] as const)('rejects incomplete final lines before %s', async (operation) => {
    const source = await fixture()
    const partial = '{"type":"user","uuid":"unfinished'
    await writeFile(source.transcriptPath, partial)
    const run =
      operation === 'rename'
        ? renameSessionTranscript(source, source.sessionId, 'Title')
        : operation === 'fork'
          ? forkSessionTranscript(source, source.sessionId)
          : deleteSessionTranscript(source, source.sessionId)
    await expect(run).rejects.toThrow('incomplete final line')
    expect(await readFile(source.transcriptPath, 'utf8')).toBe(partial)
    expect(await readdir(source.directory)).toEqual([`${source.sessionId}.jsonl`])
  })

  it('forks complete raw content, repairs progress parents and remaps compact/tool references', async () => {
    const source = await fixture()
    const user = randomUUID(),
      assistant = randomUUID(),
      progress = randomUUID(),
      result = randomUUID(),
      compact = randomUUID(),
      attachment = randomUUID(),
      micro = randomUUID()
    await source.write([
      { type: 'user', uuid: user, parentUuid: null, sessionId: source.sessionId, cwd: '/repo/.claude/worktrees/feature', timestamp: '2024-01-01T00:00:00Z', message: { content: 'First prompt' } },
      {
        type: 'assistant',
        uuid: assistant,
        parentUuid: user,
        sessionId: source.sessionId,
        slug: 'old-slug',
        teamName: 'old-team',
        message: {
          id: 'api-id',
          content: [
            { type: 'thinking', thinking: 'opaque', signature: 'signature' },
            { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'file' } },
          ],
        },
      },
      { type: 'progress', uuid: progress, parentUuid: assistant, sessionId: source.sessionId },
      {
        type: 'user',
        uuid: result,
        parentUuid: progress,
        sourceToolAssistantUUID: assistant,
        sessionId: source.sessionId,
        isMeta: true,
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'large raw result' }] },
      },
      { type: 'attachment', uuid: attachment, parentUuid: result, sessionId: source.sessionId, attachment: { type: 'context', content: 'raw attachment' } },
      {
        type: 'system',
        subtype: 'compact_boundary',
        uuid: compact,
        parentUuid: null,
        logicalParentUuid: result,
        sessionId: source.sessionId,
        compactMetadata: { trigger: 'auto', preservedSegment: { headUuid: assistant, tailUuid: result, anchorUuid: user } },
      },
      {
        type: 'system',
        subtype: 'microcompact_boundary',
        uuid: micro,
        parentUuid: compact,
        sessionId: source.sessionId,
        microcompactMetadata: { clearedAttachmentUUIDs: [attachment], compactedToolIds: ['tool-1'] },
      },
      {
        type: 'content-replacement',
        sessionId: source.sessionId,
        replacements: [
          { kind: 'tool-result', toolUseId: 'tool-1', replacement: 'exact persisted preview' },
          { kind: 'tool-result', toolUseId: 'absent', replacement: 'not copied' },
        ],
      },
      { type: 'content-replacement', sessionId: source.sessionId, agentId: 'subagent', replacements: [{ kind: 'tool-result', toolUseId: 'tool-1', replacement: 'subagent preview' }] },
      { type: 'assistant', uuid: randomUUID(), isSidechain: true, message: { content: 'sidechain' } },
      { type: 'file-history-snapshot', messageId: user, snapshot: { undo: true } },
      { type: 'custom-title', sessionId: source.sessionId, customTitle: 'Old title' },
      { type: 'custom-title', sessionId: source.sessionId, customTitle: 'Latest title' },
    ])
    await mkdir(join(source.directory, source.sessionId, 'subagents'), { recursive: true })
    await writeFile(join(source.directory, source.sessionId, 'subagents', 'agent-a.jsonl'), 'private\n')
    const original = await readFile(source.transcriptPath)
    const forkId = await forkSessionTranscript(source, source.sessionId)
    const forkPath = join(source.directory, `${forkId}.jsonl`)
    const fork = await records(forkPath)
    expect(fork.map((entry) => entry.type)).toEqual(['user', 'assistant', 'user', 'attachment', 'system', 'system', 'content-replacement', 'custom-title'])
    const [u, a, r, att, c, m] = fork
    expect(new Set(fork.slice(0, 6).map((entry) => entry.uuid)).size).toBe(6)
    expect(fork.slice(0, 6).every((entry) => entry.sessionId === forkId && !new Set<string>([user, assistant, result, attachment, compact, micro]).has(entry.uuid))).toBe(true)
    expect(a).toMatchObject({
      parentUuid: u!.uuid,
      message: {
        id: 'api-id',
        content: [
          { type: 'thinking', thinking: 'opaque', signature: 'signature' },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'file' } },
        ],
      },
    })
    expect(a).not.toHaveProperty('slug')
    expect(a).not.toHaveProperty('teamName')
    expect(r).toMatchObject({ parentUuid: a!.uuid, sourceToolAssistantUUID: a!.uuid, isMeta: true })
    expect(c).toMatchObject({ parentUuid: null, logicalParentUuid: r!.uuid, compactMetadata: { preservedSegment: { headUuid: a!.uuid, tailUuid: r!.uuid, anchorUuid: u!.uuid } } })
    expect(m!.microcompactMetadata).toEqual({ clearedAttachmentUUIDs: [att!.uuid], compactedToolIds: ['tool-1'] })
    expect(u!.timestamp).toBe('2024-01-01T00:00:00Z')
    expect(m!.forkedFrom).toEqual({ sessionId: source.sessionId, messageUuid: micro })
    expect(fork.at(-2)).toMatchObject({ replacements: [{ kind: 'tool-result', toolUseId: 'tool-1', replacement: 'exact persisted preview' }] })
    expect(fork.at(-1)?.customTitle).toBe('Latest title (fork)')
    expect((await stat(forkPath)).mode & 0o777).toBe(0o600)
    await expect(stat(join(source.directory, forkId))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(source.transcriptPath)).toEqual(original)
  })

  it('uses inclusive opaque UUID cutoff and keeps only relevant replacements', async () => {
    const source = await fixture()
    await source.write([
      { type: 'user', uuid: 'first', message: { content: 'First prompt' } },
      { type: 'assistant', uuid: 'assistant-response-42', parentUuid: 'first', message: { content: [{ type: 'text', text: 'answer' }] } },
      { type: 'user', uuid: 'later', parentUuid: 'assistant-response-42', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-later', content: 'later' }] } },
      { type: 'content-replacement', sessionId: source.sessionId, replacements: [{ kind: 'tool-result', toolUseId: 'tool-later', replacement: 'later' }] },
    ])
    const forkId = await forkSessionTranscript(source, source.sessionId, 'assistant-response-42')
    const fork = await records(join(source.directory, `${forkId}.jsonl`))
    expect(fork.map((entry) => entry.type)).toEqual(['user', 'assistant', 'custom-title'])
    expect(fork.at(-1)?.customTitle).toBe('First prompt (fork)')
    await expect(forkSessionTranscript(source, source.sessionId, 'not-found')).rejects.toThrow('not found')
    expect(await readdir(source.directory)).toHaveLength(2)
  })

  it('fails on malformed records and missing compact references without creating a fork', async () => {
    const source = await fixture()
    await writeFile(source.transcriptPath, '{bad json}\n')
    await expect(forkSessionTranscript(source, source.sessionId)).rejects.toThrow(SessionTranscriptMutationError)
    await source.write([{ type: 'system', uuid: 'compact', compactMetadata: { preservedSegment: { headUuid: 'missing', tailUuid: 'missing', anchorUuid: 'missing' } } }])
    await expect(forkSessionTranscript(source, source.sessionId)).rejects.toThrow('preserved compact segment')
    expect(await readdir(source.directory)).toEqual([`${source.sessionId}.jsonl`])
  })

  it('deletes only the injected source and its sibling session directory', async () => {
    const source = await fixture([{ type: 'user', uuid: randomUUID() }])
    const subagents = join(source.directory, source.sessionId, 'subagents')
    await mkdir(subagents, { recursive: true })
    await writeFile(join(subagents, 'agent-a.jsonl'), '{}\n')
    const sibling = join(source.directory, `${randomUUID()}.jsonl`)
    await writeFile(sibling, '{}\n')
    await deleteSessionTranscript(source, source.sessionId)
    await expect(stat(source.transcriptPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(subagents)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(sibling, 'utf8')).toBe('{}\n')
  })

  it('remaps compactMetadata.preservedMessages and rejects cutoffs that exclude them', async () => {
    const source = await fixture()
    const user1 = randomUUID(),
      assistant1 = randomUUID(),
      user2 = randomUUID(),
      compactObj = randomUUID(),
      compactArr = randomUUID()
    await source.write([
      { type: 'user', uuid: user1, parentUuid: null, sessionId: source.sessionId, message: { role: 'user', content: 'First' } },
      { type: 'assistant', uuid: assistant1, parentUuid: user1, sessionId: source.sessionId, message: { role: 'assistant', content: [{ type: 'text', text: 'Reply' }] } },
      { type: 'user', uuid: user2, parentUuid: assistant1, sessionId: source.sessionId, message: { role: 'user', content: 'Second' } },
      {
        type: 'system',
        subtype: 'compact_boundary',
        uuid: compactObj,
        parentUuid: null,
        logicalParentUuid: user2,
        sessionId: source.sessionId,
        compactMetadata: {
          trigger: 'auto',
          preservedSegment: { headUuid: assistant1, tailUuid: user2, anchorUuid: user1 },
          preservedMessages: { anchorUuid: user1, uuids: [assistant1, user2], allUuids: [user1, assistant1, user2] },
        },
      },
      {
        type: 'system',
        subtype: 'compact_boundary',
        uuid: compactArr,
        parentUuid: compactObj,
        sessionId: source.sessionId,
        compactMetadata: { trigger: 'manual', preservedMessages: [assistant1, user2] },
      },
    ])
    const forkId = await forkSessionTranscript(source, source.sessionId)
    const fork = await records(join(source.directory, `${forkId}.jsonl`))
    const [u1, a1, u2, cObj, cArr] = fork
    expect(cObj!.compactMetadata).toEqual({
      trigger: 'auto',
      preservedSegment: { headUuid: a1!.uuid, tailUuid: u2!.uuid, anchorUuid: u1!.uuid },
      preservedMessages: { anchorUuid: u1!.uuid, uuids: [a1!.uuid, u2!.uuid], allUuids: [u1!.uuid, a1!.uuid, u2!.uuid] },
    })
    expect(cArr!.compactMetadata).toEqual({
      trigger: 'manual',
      preservedMessages: [a1!.uuid, u2!.uuid],
    })

    // Missing preservedMessages reference fails without creating a fork.
    await source.write([
      { type: 'user', uuid: user1, parentUuid: null, sessionId: source.sessionId, message: { role: 'user', content: 'First' } },
      {
        type: 'system',
        subtype: 'compact_boundary',
        uuid: compactObj,
        parentUuid: null,
        sessionId: source.sessionId,
        compactMetadata: { trigger: 'auto', preservedMessages: { anchorUuid: user1, uuids: [user1, 'missing-uuid'] } },
      },
    ])
    const beforeFiles = await readdir(source.directory)
    await expect(forkSessionTranscript(source, source.sessionId)).rejects.toThrow('preserved compact messages')
    expect(await readdir(source.directory)).toEqual(beforeFiles)
  })

  it('remaps only known attachment UUID fields and preserves UUID-shaped content', async () => {
    const user = randomUUID(),
      assistant = randomUUID(),
      progress = randomUUID()
    const attachments = [
      { type: 'queued_command', source_uuid: user, prompt: user },
      { type: 'queued_command', source_uuid: assistant, prompt: [{ type: 'text', text: assistant }] },
      { type: 'queued_command', source_uuid: progress, prompt: progress },
      { type: 'queued_command', source_uuid: 'unmapped-source', prompt: user },
      {
        type: 'deferred_tools_record',
        nameOnlyAnnouncements: [user, assistant, progress, 'missing', null],
        prompt: user,
        text: assistant,
      },
      { type: 'unknown', source_uuid: user, nameOnlyAnnouncements: [assistant], nested: { text: user, values: [assistant] } },
    ]
    const messages = [
      { type: 'user', uuid: user, parentUuid: null, message: { role: 'user', content: user } },
      { type: 'assistant', uuid: assistant, parentUuid: user, message: { role: 'assistant', content: [{ type: 'text', text: assistant }] } },
    ]
    const source = await fixture([
      ...messages,
      { type: 'progress', uuid: progress, parentUuid: assistant },
      ...attachments.map((attachment) => ({ type: 'attachment', uuid: randomUUID(), parentUuid: progress, attachment })),
    ])
    const forkId = await forkSessionTranscript(source, source.sessionId)
    const fork = await records(join(source.directory, `${forkId}.jsonl`))
    expect(fork.slice(0, 2).map((entry) => entry.message)).toEqual(messages.map((entry) => entry.message))
    expect(fork.slice(2, -1).map((entry) => entry.attachment)).toEqual([
      { ...attachments[0], source_uuid: fork[0]!.uuid },
      { ...attachments[1], source_uuid: fork[1]!.uuid },
      attachments[2],
      attachments[3],
      { ...attachments[4], nameOnlyAnnouncements: [fork[0]!.uuid, fork[1]!.uuid] },
      attachments[5],
    ])
  })

  it('matches transcript title rules for image-only, bash-input, and nested fork titles', async () => {
    const imageSource = await fixture([
      {
        type: 'user',
        uuid: randomUUID(),
        parentUuid: null,
        message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }] },
      },
    ])
    const imageForkId = await forkSessionTranscript(imageSource, imageSource.sessionId)
    const imageFork = await records(join(imageSource.directory, `${imageForkId}.jsonl`))
    expect(imageFork.at(-1)?.customTitle).toBe('Image prompt (fork)')

    const bashSource = await fixture([
      {
        type: 'user',
        uuid: randomUUID(),
        parentUuid: null,
        message: { role: 'user', content: '<bash-input>ls -la</bash-input>' },
      },
    ])
    const bashForkId = await forkSessionTranscript(bashSource, bashSource.sessionId)
    const bashFork = await records(join(bashSource.directory, `${bashForkId}.jsonl`))
    expect(bashFork.at(-1)?.customTitle).toBe('! ls -la (fork)')

    const nestedForkId = await forkSessionTranscript({ transcriptPath: join(bashSource.directory, `${bashForkId}.jsonl`) }, bashForkId)
    const nestedFork = await records(join(bashSource.directory, `${nestedForkId}.jsonl`))
    expect(nestedFork.at(-1)?.customTitle).toBe('! ls -la (fork) (fork)')
  })

  it.each([16, 64])('copies at most twice the input bytes for a single %i-chunk line', async (chunks) => {
    const content = Array.from({ length: chunks }, (_, index) => String.fromCharCode(65 + (index % 26)).repeat(64 * 1024)).join('')
    const message = { role: 'assistant', content }
    const source = await fixture([{ type: 'assistant', uuid: randomUUID(), message }])
    const inputBytes = (await stat(source.transcriptPath)).size
    const concat = vi.spyOn(Buffer, 'concat')
    const from = vi.spyOn(Buffer, 'from')
    let forkId: string
    let copiedBytes: number
    let mergedLines: number
    try {
      forkId = await forkSessionTranscript(source, source.sessionId)
      // Count actual buffer-copy volume, excluding string encoding for fork output.
      copiedBytes = from.mock.calls.reduce((sum, [value]) => sum + (Buffer.isBuffer(value) ? value.length : 0), 0)
      copiedBytes += concat.mock.results.reduce((sum, result) => sum + (result.type === 'return' ? result.value.length : 0), 0)
      mergedLines = concat.mock.calls.length
    } finally {
      concat.mockRestore()
      from.mockRestore()
    }
    const fork = await records(join(source.directory, `${forkId}.jsonl`))
    expect(fork[0]!.message).toEqual(message)
    expect(copiedBytes).toBeLessThanOrEqual(2 * inputBytes)
    expect(mergedLines).toBe(1)
  })

  it.each([1, 2, 3])('preserves UTF-8 characters split after byte %i at a read boundary', async (splitBytes) => {
    const prefix = '{"type":"assistant","uuid":"utf8","message":{"role":"assistant","content":"'
    const content = `${'x'.repeat(64 * 1024 - Buffer.byteLength(prefix) - splitBytes)}𝄞中文`
    const source = await fixture()
    await writeFile(source.transcriptPath, `${prefix}${content}"}}\n`)
    const forkId = await forkSessionTranscript(source, source.sessionId)
    const fork = await records(join(source.directory, `${forkId}.jsonl`))
    expect(fork[0]!.message).toEqual({ role: 'assistant', content })
  })

  it('streams multi-chunk transcripts across read and write batches without corrupting records', async () => {
    const payload = 'x'.repeat(2_000)
    const entries = Array.from({ length: 200 }, (_, index) => ({
      type: index % 2 === 0 ? 'user' : 'assistant',
      uuid: `msg-${index}`,
      parentUuid: index === 0 ? null : `msg-${index - 1}`,
      message: { role: index % 2 === 0 ? 'user' : 'assistant', content: index === 0 ? 'Large transcript' : payload },
    }))
    const source = await fixture(entries)
    const forkId = await forkSessionTranscript(source, source.sessionId)
    const fork = await records(join(source.directory, `${forkId}.jsonl`))
    expect(fork).toHaveLength(201)
    expect(fork.slice(0, -1).map((entry) => entry.message)).toEqual(entries.map((entry) => entry.message))
    expect(fork.slice(0, -1).map((entry) => entry.parentUuid)).toEqual([null, ...fork.slice(0, -2).map((entry) => entry.uuid)])
    expect(fork.at(-1)).toEqual({ type: 'custom-title', sessionId: forkId, customTitle: 'Large transcript (fork)' })
  })
})
