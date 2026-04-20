import { describe, expect, it } from 'vitest'
import {
  buildSessionInteractionResponseInput,
  mapPendingInteraction,
} from './interactionVm'
import type {
  PendingInteraction,
  PermissionInteraction,
  SdkElicitationInteraction,
} from '../../contract/runtime'

function createPermissionInteraction(): PermissionInteraction {
  return {
    id: 'permission-1',
    kind: 'permission',
    status: 'pending',
    source: {
      kind: 'tool',
      toolName: 'Bash',
      toolUseId: 'tool-1',
    },
    blocksRun: true,
    toolName: 'Bash',
    input: {
      command: 'ls -la',
    },
    title: 'Allow Bash',
    displayName: 'Bash',
    description: 'Needs shell access',
    decisionReason: 'required',
    blockedPath: '/tmp/demo',
    toolUseId: 'tool-1',
    agentId: 'agent-1',
    permissionSuggestions: [
      {
        action: 'allow',
        label: 'Allow once',
        description: 'Only this time',
        raw: { type: 'allow_once' },
      },
      {
        action: 'allow',
        label: 'Allow for session',
        description: 'Reuse within this session',
        scope: 'session',
        raw: { type: 'allow_session' },
      },
    ],
  }
}

function createElicitationInteraction(): SdkElicitationInteraction {
  return {
    id: 'elicitation-1',
    kind: 'elicitation',
    status: 'pending',
    source: {
      kind: 'host',
      subtype: 'ask-user',
    },
    serverName: 'demo-server',
    message: 'Need a value',
    toolUseId: 'tool-2',
    mode: 'form',
    url: 'https://example.com',
    requestedSchema: {
      type: 'object',
      properties: {
        answer: { type: 'string' },
      },
    },
  }
}

describe('mapPendingInteraction', () => {
  it('returns null for empty interaction', () => {
    expect(mapPendingInteraction(null)).toBeNull()
    expect(mapPendingInteraction(undefined)).toBeNull()
  })

  it('maps permission interactions into timeline vm with stable suggestion keys', () => {
    const interaction = createPermissionInteraction()

    const result = mapPendingInteraction(interaction)

    expect(result).toMatchObject({
      id: 'permission-1',
      kind: 'permission',
      toolName: 'Bash',
      blocksRun: true,
      input: { command: 'ls -la' },
      permissionSuggestions: [
        {
          key: 'once::allow::0',
          action: 'allow',
          label: 'Allow once',
        },
        {
          key: 'session::allow::1',
          action: 'allow',
          scope: 'session',
          label: 'Allow for session',
        },
      ],
    })
  })

  it('maps elicitation interactions into timeline vm', () => {
    const interaction = createElicitationInteraction()

    const result = mapPendingInteraction(interaction)

    expect(result).toEqual({
      id: 'elicitation-1',
      kind: 'elicitation',
      status: 'pending',
      source: {
        kind: 'host',
        subtype: 'ask-user',
      },
      serverName: 'demo-server',
      message: 'Need a value',
      toolUseId: 'tool-2',
      mode: 'form',
      url: 'https://example.com',
      requestedSchema: {
        type: 'object',
        properties: {
          answer: { type: 'string' },
        },
      },
    })
  })
})

describe('buildSessionInteractionResponseInput', () => {
  it('maps selected permission suggestion key back to raw payload', () => {
    const interaction = createPermissionInteraction()

    const result = buildSessionInteractionResponseInput(
      {
        kind: 'permission',
        decision: 'approve',
        selectedSuggestionKey: 'session::allow::1',
        content: {
          note: 'ok',
        },
      },
      interaction,
    )

    expect(result).toEqual({
      kind: 'permission',
      requestId: 'permission-1',
      response: {
        decision: 'approve',
        selectedSuggestion: { type: 'allow_session' },
        content: {
          note: 'ok',
        },
      },
    })
  })

  it('falls back gracefully when permission suggestion key is missing', () => {
    const interaction = createPermissionInteraction()

    const result = buildSessionInteractionResponseInput(
      {
        kind: 'permission',
        decision: 'deny',
      },
      interaction,
    )

    expect(result).toEqual({
      kind: 'permission',
      requestId: 'permission-1',
      response: {
        decision: 'deny',
      },
    })
  })

  it('maps elicitation responses without permission-specific fields', () => {
    const interaction = createElicitationInteraction() as PendingInteraction

    const result = buildSessionInteractionResponseInput(
      {
        kind: 'elicitation',
        action: 'accept',
        content: {
          answer: 'yes',
        },
      },
      interaction,
    )

    expect(result).toEqual({
      kind: 'elicitation',
      requestId: 'elicitation-1',
      response: {
        action: 'accept',
        content: {
          answer: 'yes',
        },
      },
    })
  })
})
