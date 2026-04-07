<script setup lang="ts">
import { computed } from 'vue'
import type { UserDisplayItem } from '../../../shared/message-types.js'

type AnsiSegment = {
  text: string
  bold?: boolean
  dim?: boolean
  colorClass?: string
}

type AnsiLine = AnsiSegment[]

const props = defineProps<{
  item: UserDisplayItem
}>()

function extractTag(content: string, tagName: string): string | null {
  const match = content.match(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`))
  return match ? match[1]!.trim() : null
}

function sanitizeCommandOutput(content: string): string {
  return content.replace(/^([A-Z0-9_]*(TOKEN|KEY|SECRET|PASSWORD)[A-Z0-9_]*=).*/gim, '$1[REDACTED]')
}

function getCommandInputSummary(content: string): string {
  const commandName = extractTag(content, 'command-name')
  const commandMessage = extractTag(content, 'command-message')
  const bashInput = extractTag(content, 'bash-input')
  if (commandName && commandMessage) return `${commandName} · ${commandMessage}`
  return commandName || bashInput || commandMessage || content
}

function getCommandOutput(content: string): string {
  const localStdout = extractTag(content, 'local-command-stdout')
  const localStderr = extractTag(content, 'local-command-stderr')
  const bashStdout = extractTag(content, 'bash-stdout')
  const bashStderr = extractTag(content, 'bash-stderr')
  const output = [bashStdout, bashStderr, localStdout, localStderr].filter(Boolean).join('\n') || content
  return sanitizeCommandOutput(output)
}

function getColorClass(codes: number[]): string | undefined {
  if (codes.includes(31)) return 'text-rose-700'
  if (codes.includes(32)) return 'text-emerald-700'
  if (codes.includes(33)) return 'text-amber-700'

  const color256Index = codes.findIndex((code, index) => code === 38 && codes[index + 1] === 5)
  const color256 = color256Index >= 0 ? codes[color256Index + 2] : undefined
  switch (color256) {
    case 220:
      return 'text-amber-500'
    case 246:
      return 'text-slate-400'
    default:
      return undefined
  }
}

function parseAnsiOutput(content: string): AnsiLine[] {
  const lines: AnsiLine[] = [[]]
  let current: Omit<AnsiSegment, 'text'> = {}
  let buffer = ''
  let index = 0

  const pushText = () => {
    if (!buffer) return
    const parts = buffer.split('\n')
    parts.forEach((part, partIndex) => {
      if (part.length > 0) {
        lines[lines.length - 1]!.push({ text: part, ...current })
      }
      if (partIndex < parts.length - 1) {
        lines.push([])
      }
    })
    buffer = ''
  }

  while (index < content.length) {
    if (content[index] === '\u001b' && content[index + 1] === '[') {
      const end = content.indexOf('m', index)
      if (end === -1) {
        buffer += content.slice(index)
        break
      }

      pushText()
      const rawCodes = content.slice(index + 2, end)
      const codes = rawCodes.length === 0
        ? [0]
        : rawCodes.split(';').map((value) => Number.parseInt(value, 10)).filter((value) => Number.isFinite(value))

      for (const code of codes) {
        switch (code) {
          case 0:
            current = {}
            break
          case 1:
            current = { ...current, bold: true, dim: false }
            break
          case 2:
            current = { ...current, dim: true, bold: false }
            break
          case 22:
            current = { ...current, bold: false, dim: false }
            break
          case 39:
            current = { ...current, colorClass: undefined }
            break
          default:
            break
        }
      }

      current = { ...current, colorClass: getColorClass(codes) ?? current.colorClass }
      index = end + 1
      continue
    }

    buffer += content[index]
    index += 1
  }

  pushText()
  return lines
}

function getAnsiSegmentClass(segment: AnsiSegment): string {
  return [
    segment.bold ? 'font-semibold' : '',
    segment.dim ? 'text-slate-500' : 'text-slate-700',
    segment.colorClass || '',
  ].filter(Boolean).join(' ')
}

const commandOutputLines = computed(() => parseAnsiOutput(getCommandOutput(props.item.message.content)))
</script>

<template>
  <div v-if="item.displayKind === 'command_input'" class="rounded-lg border border-slate-200 bg-slate-50/80 px-3 py-2 text-sm text-slate-700">
    <span class="font-medium text-slate-900">Command</span>
    <span class="text-slate-400"> · </span>
    <span>{{ getCommandInputSummary(item.message.content) }}</span>
  </div>
  <div v-else-if="item.displayKind === 'command_output'" class="rounded-lg border border-slate-200 bg-slate-50/80 px-3 py-2 text-sm leading-6">
    <div v-for="(line, lineIndex) in commandOutputLines" :key="`${item.id}-line-${lineIndex}`" class="whitespace-pre-wrap break-words">
      <template v-if="line.length > 0">
        <span
          v-for="(segment, segmentIndex) in line"
          :key="`${item.id}-line-${lineIndex}-segment-${segmentIndex}`"
          :class="getAnsiSegmentClass(segment)"
        >{{ segment.text }}</span>
      </template>
      <span v-else>&nbsp;</span>
    </div>
  </div>
  <div v-else class="whitespace-pre-wrap text-[15px] leading-7 text-slate-900">{{ item.message.content }}</div>
</template>
