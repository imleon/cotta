import type { PendingInteraction } from '../../../shared/message-types.js'

const baseSource = {
  kind: 'control' as const,
  subtype: 'elicitation',
}

export const elicitationFixtures: PendingInteraction[] = [
  {
    id: 'fixture-form-text',
    kind: 'elicitation',
    status: 'pending',
    source: baseSource,
    serverName: 'fixture-server',
    message: 'Please provide your email address.',
    requestedSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          title: 'Email',
          description: 'Used for notifications',
          format: 'email',
          default: 'user@example.com',
        },
      },
      required: ['email'],
    },
  },
  {
    id: 'fixture-form-boolean',
    kind: 'elicitation',
    status: 'pending',
    source: baseSource,
    serverName: 'fixture-server',
    message: 'Enable deployment notifications?',
    requestedSchema: {
      type: 'object',
      properties: {
        enabled: {
          type: 'boolean',
          title: 'Enable notifications',
          description: 'Turn on notifications for this deployment',
          default: true,
        },
      },
      required: ['enabled'],
    },
  },
  {
    id: 'fixture-form-single-select',
    kind: 'elicitation',
    status: 'pending',
    source: baseSource,
    serverName: 'fixture-server',
    message: 'Choose an environment.',
    requestedSchema: {
      type: 'object',
      properties: {
        environment: {
          type: 'string',
          title: 'Environment',
          description: 'Select the target environment',
          oneOf: [
            { const: 'dev', title: 'Development' },
            { const: 'staging', title: 'Staging' },
            { const: 'prod', title: 'Production' },
          ],
          default: 'staging',
        },
      },
      required: ['environment'],
    },
  },
  {
    id: 'fixture-form-multi-select',
    kind: 'elicitation',
    status: 'pending',
    source: baseSource,
    serverName: 'fixture-server',
    message: 'Select deployment regions.',
    requestedSchema: {
      type: 'object',
      properties: {
        regions: {
          type: 'array',
          title: 'Regions',
          description: 'Choose one or more regions',
          items: {
            anyOf: [
              { const: 'ap-sg', title: 'Singapore' },
              { const: 'us-va', title: 'Virginia' },
              { const: 'eu-de', title: 'Frankfurt' },
            ],
          },
          default: ['ap-sg'],
          minItems: 1,
          maxItems: 2,
        },
      },
      required: ['regions'],
    },
  },
  {
    id: 'fixture-url-open',
    kind: 'elicitation',
    status: 'pending',
    source: baseSource,
    serverName: 'fixture-server',
    message: 'Open the verification URL and complete sign-in.',
    mode: 'url',
    url: 'https://example.com/verify',
  },
  {
    id: 'fixture-generic-json-fallback',
    kind: 'elicitation',
    status: 'pending',
    source: baseSource,
    serverName: 'fixture-server',
    message: 'Provide a structured deployment payload.',
    requestedSchema: {
      type: 'object',
      properties: {
        service: {
          type: 'string',
          title: 'Service',
        },
        metadata: {
          type: 'object',
          title: 'Metadata',
          properties: {
            region: { type: 'string' },
            canary: { type: 'boolean' },
          },
        },
      },
      required: ['service'],
    },
  },
]
