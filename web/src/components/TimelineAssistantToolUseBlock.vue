<script setup lang="ts">
import { computed } from 'vue'
import { useSessionStore } from '../stores/session'
import type { DisplayFragmentToolUse, SdkElicitationInteraction, PermissionInteraction } from '../../../runtime/protocol/message-types.js'
import { stringifyStructuredValue } from '../../../runtime/protocol/transcript-normalizer.js'
import TimelineCanUseToolInteractionBlock from './TimelineCanUseToolInteractionBlock.vue'
import TimelineElicitationInteractionBlock from './TimelineElicitationInteractionBlock.vue'

const props = withDefaults(defineProps<{
  fragment: DisplayFragmentToolUse
  status?: 'streaming' | 'completed' | 'errored'
  trailingToggleLabel?: string
}>(), {
  status: 'completed',
  trailingToggleLabel: '',
})

const session = useSessionStore()

const emit = defineEmits<{
  toggle: []
}>()

const toolLabel = computed(() => {
  const name = props.fragment.name || 'unknown_tool'
  if (!props.fragment.input) return name

  const inputText = stringifyStructuredValue(props.fragment.input).trim().replace(/\s+/g, ' ')
  const compact = inputText.length > 72 ? `${inputText.slice(0, 72)}…` : inputText
  return `${name}(${compact})`
})

const statusTextClass = computed(() => {
  switch (props.status) {
    case 'streaming':
      return 'text-[var(--tt-primary)]'
    case 'errored':
      return 'text-[var(--tt-danger)]'
    default:
      return 'text-[var(--tt-text-muted)]'
  }
})

const pendingPermissionInteraction = computed<PermissionInteraction | null>(() => {
  const interaction = session.pendingInteraction
  if (interaction?.kind !== 'permission') return null
  if (!interaction.toolUseId || interaction.toolUseId !== props.fragment.toolUseId) return null
  return interaction
})

const pendingElicitationInteraction = computed<SdkElicitationInteraction | null>(() => {
  const interaction = session.pendingInteraction
  if (interaction?.kind !== 'elicitation') return null
  if (!interaction.toolUseId || interaction.toolUseId !== props.fragment.toolUseId) return null
  return interaction
})
</script>

<template>
  <div class="space-y-2">
    <div class="flex items-start gap-3 text-[var(--tt-text)]">
      <span class="min-w-0 flex-1">
        <span :class="statusTextClass">{{ toolLabel }}</span>
        <button
          v-if="trailingToggleLabel"
          class="timeline-cli-button ml-2 inline align-baseline"
          @click="emit('toggle')"
        >
          {{ trailingToggleLabel }}
        </button>
      </span>
    </div>
    <div v-if="pendingPermissionInteraction" class="pl-7">
      <TimelineCanUseToolInteractionBlock :interaction="pendingPermissionInteraction" :fragment="fragment" attached />
    </div>
    <div v-if="pendingElicitationInteraction" class="pl-7">
      <TimelineElicitationInteractionBlock :interaction="pendingElicitationInteraction" attached />
    </div>
  </div>
</template>
