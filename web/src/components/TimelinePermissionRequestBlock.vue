<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useSessionStore } from '../stores/session'
import type { PendingPermissionInteraction, PermissionSuggestion } from '../../../shared/message-types.js'

const props = defineProps<{
  interaction: PendingPermissionInteraction
}>()

const session = useSessionStore()
const selectedPermissionSuggestionAction = ref('')
const submittedDecision = ref<'approve' | 'deny' | null>(null)

const title = computed(() => props.interaction.title || props.interaction.displayName || props.interaction.toolName || 'Pending interaction')
const description = computed(() => props.interaction.description || '')
const reason = computed(() => props.interaction.decisionReason || '')
const suggestions = computed(() => props.interaction.permissionSuggestions || [])
const isSubmitted = computed(() => submittedDecision.value !== null)

const selectedSuggestion = computed<PermissionSuggestion | null>(() => {
  if (suggestions.value.length === 0) return null
  return suggestions.value.find((suggestion) => suggestion.action === selectedPermissionSuggestionAction.value) || suggestions.value[0] || null
})

function getDefaultPermissionSuggestionAction(nextSuggestions: PermissionSuggestion[]): string {
  if (nextSuggestions.length === 0) return ''
  return nextSuggestions.find((suggestion) => suggestion.scope === 'session')?.action
    || nextSuggestions.find((suggestion) => suggestion.action === 'allow')?.action
    || nextSuggestions[0]?.action
    || ''
}

function submitPermission(decision: 'approve' | 'deny') {
  submittedDecision.value = decision
  session.respondToPermission(decision, decision === 'approve' ? selectedSuggestion.value || undefined : undefined)
}

watch(
  () => props.interaction.id,
  () => {
    selectedPermissionSuggestionAction.value = getDefaultPermissionSuggestionAction(suggestions.value)
    submittedDecision.value = null
  },
  { immediate: true },
)
</script>

<template>
  <div class="rounded-xl border border-[color:color-mix(in_srgb,var(--tt-coral)_55%,white)] bg-[color:color-mix(in_srgb,var(--tt-surface)_76%,white)] px-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.45)]">
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] leading-5 text-[var(--tt-text-muted)]">
      <span class="font-medium text-[var(--tt-primary-strong)]">Permission required</span>
      <span class="text-[var(--tt-text-subtle)]">·</span>
      <span class="text-[var(--tt-text-muted)]">{{ title }}</span>
    </div>

    <div v-if="description" class="mt-1 text-[12px] leading-5 text-[var(--tt-text-muted)]">
      {{ description }}
    </div>
    <div v-if="reason" class="mt-1 text-[12px] leading-5 text-[var(--tt-text-subtle)]">
      {{ reason }}
    </div>

    <div v-if="suggestions.length" class="mt-3 space-y-2">
      <div class="text-[11px] uppercase tracking-wide text-[var(--tt-text-subtle)]">
        Permission scope
      </div>
      <label
        v-for="suggestion in suggestions"
        :key="`${interaction.id}-${suggestion.action}-${suggestion.scope || 'default'}`"
        class="flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2 text-[12px] leading-5 transition-colors"
        :class="selectedPermissionSuggestionAction === suggestion.action
          ? 'border-[var(--tt-border-strong)] bg-[var(--tt-card)] text-[var(--tt-text)]'
          : 'border-[color:color-mix(in_srgb,var(--tt-border)_82%,white)] bg-white/65 text-[var(--tt-text-subtle)] hover:border-[var(--tt-border)] hover:bg-white/80'"
      >
        <input
          v-model="selectedPermissionSuggestionAction"
          type="radio"
          name="permission-suggestion"
          class="mt-1"
          :value="suggestion.action"
          :disabled="isSubmitted"
        >
        <span class="min-w-0 flex-1">
          <span class="block text-[var(--tt-text)]">{{ suggestion.label || suggestion.action }}</span>
          <span v-if="suggestion.description || suggestion.scope" class="block text-[11px] text-[var(--tt-text-subtle)]">
            {{ suggestion.description || suggestion.scope }}
          </span>
        </span>
      </label>
    </div>

    <div class="mt-3 flex flex-wrap gap-2 text-[12px]">
      <button
        class="rounded-md border px-2.5 py-1.5 transition-colors"
        :class="submittedDecision === 'approve'
          ? 'border-[var(--tt-primary)] bg-[var(--tt-primary)] text-white'
          : isSubmitted
            ? 'border-[var(--tt-border)] bg-white/70 text-[var(--tt-text-subtle)]'
            : 'border-[color:color-mix(in_srgb,var(--tt-primary)_28%,white)] bg-white text-[var(--tt-text)] hover:border-[var(--tt-primary)] hover:text-[var(--tt-primary-strong)]'"
        :disabled="isSubmitted"
        @click="submitPermission('approve')"
      >
        {{ submittedDecision === 'approve' ? 'Allowed' : 'Allow' }}
      </button>
      <button
        class="rounded-md border px-2.5 py-1.5 transition-colors"
        :class="submittedDecision === 'deny'
          ? 'border-[var(--tt-danger)] bg-[var(--tt-danger)] text-white'
          : isSubmitted
            ? 'border-[var(--tt-border)] bg-white/70 text-[var(--tt-text-subtle)]'
            : 'border-[var(--tt-border)] bg-white text-[var(--tt-text-muted)] hover:border-[var(--tt-danger)] hover:text-[var(--tt-danger)]'"
        :disabled="isSubmitted"
        @click="submitPermission('deny')"
      >
        {{ submittedDecision === 'deny' ? 'Denied' : 'Deny' }}
      </button>
    </div>
  </div>
</template>
