import type { SdkElicitationInteraction } from '../protocol/message-types.js'

export type ElicitationOption = {
  value: string
  label: string
}

export type ElicitationFormField =
  | {
      type: 'text'
      field: string
      label: string
      description?: string
      valueType: 'string' | 'number' | 'integer'
      defaultValue?: string | number
      required: boolean
      format?: string
      pattern?: string
      minLength?: number
      maxLength?: number
      minimum?: number
      maximum?: number
      placeholder?: string
      multiline?: boolean
    }
  | {
      type: 'boolean'
      field: string
      label: string
      description?: string
      defaultValue?: boolean
      required: boolean
    }
  | {
      type: 'single_select'
      field: string
      label: string
      description?: string
      options: ElicitationOption[]
      defaultValue?: string
      required: boolean
    }
  | {
      type: 'multi_select'
      field: string
      label: string
      description?: string
      options: ElicitationOption[]
      defaultValue?: string[]
      required: boolean
      minSelections?: number
      maxSelections?: number
    }

export type ElicitationRenderer =
  | {
      type: 'url_open'
      title: string
      description?: string
      url: string
    }
  | {
      type: 'form_object'
      title: string
      description?: string
      fields: ElicitationFormField[]
      /**
       * Some MCP servers wrap the actual form in a single top-level container
       * field; when present, we nest the response under that field.
       */
      containerField?: string
    }
  | {
      type: 'form_text'
      title: string
      description?: string
      field: string
      containerField?: string
      valueType: 'string' | 'number' | 'integer'
      defaultValue?: string | number
      required: boolean
      format?: string
      minLength?: number
      maxLength?: number
      minimum?: number
      maximum?: number
      placeholder?: string
    }
  | {
      type: 'form_boolean'
      title: string
      description?: string
      field: string
      containerField?: string
      defaultValue?: boolean
      required: boolean
    }
  | {
      type: 'form_single_select'
      title: string
      description?: string
      field: string
      containerField?: string
      options: ElicitationOption[]
      defaultValue?: string
      required: boolean
    }
  | {
      type: 'form_multi_select'
      title: string
      description?: string
      field: string
      containerField?: string
      options: ElicitationOption[]
      defaultValue?: string[]
      required: boolean
      minSelections?: number
      maxSelections?: number
    }
  | {
      type: 'generic_json_fallback'
      title: string
      description?: string
    }

type PropertyContext = {
  property: Record<string, unknown>
  field: string
  containerField?: string
  required: boolean
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : []
}

function getNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function getBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function makeTitle(interaction: SdkElicitationInteraction, property?: Record<string, unknown>): string {
  return getString(property?.title)
    || interaction.message
    || interaction.serverName
    || 'Interaction required'
}

function makeDescription(interaction: SdkElicitationInteraction, property?: Record<string, unknown>): string | undefined {
  const propertyDescription = getString(property?.description)
  if (propertyDescription) return propertyDescription
  const message = getString(interaction.message)
  const title = getString(property?.title)
  if (message && message !== title) return message
  return undefined
}

function getRequiredFields(schema: Record<string, unknown> | null): Set<string> {
  return new Set(getStringArray(schema?.required))
}

function getMultiPropertyContext(interaction: SdkElicitationInteraction): { containerField?: string; properties: Record<string, Record<string, unknown>>; requiredFields: Set<string> } | null {
  const schema = asRecord(interaction.requestedSchema)
  const properties = asRecord(schema?.properties)
  if (!properties) return null

  const requiredFields = getRequiredFields(schema)
  const topLevelKeys = Object.keys(properties)
  if (topLevelKeys.length === 0) return null

  // If it's a single top-level container with nested properties, treat that as containerField.
  if (topLevelKeys.length === 1) {
    const containerField = topLevelKeys[0]
    const containerProperty = asRecord(properties[containerField])
    const nestedProperties = asRecord(containerProperty?.properties)
    if (nestedProperties) {
      const nestedRequired = getRequiredFields(containerProperty)
      const nested: Record<string, Record<string, unknown>> = {}
      for (const [key, value] of Object.entries(nestedProperties)) {
        const property = asRecord(value)
        if (!property) continue
        nested[key] = property
      }
      return { containerField, properties: nested, requiredFields: new Set([...requiredFields, ...nestedRequired]) }
    }
  }

  const flattened: Record<string, Record<string, unknown>> = {}
  for (const [key, value] of Object.entries(properties)) {
    const property = asRecord(value)
    if (!property) continue
    flattened[key] = property
  }
  return { properties: flattened, requiredFields }
}

function getSinglePropertyContext(interaction: SdkElicitationInteraction): PropertyContext | null {
  const schema = asRecord(interaction.requestedSchema)
  const properties = asRecord(schema?.properties)
  if (!properties) return null

  const requiredFields = getRequiredFields(schema)
  const topLevelKeys = Object.keys(properties)
  if (topLevelKeys.length !== 1) return null

  const field = topLevelKeys[0]
  if (!field) return null

  const property = asRecord(properties[field])
  if (!property) return null

  const nestedProperties = asRecord(property.properties)
  if (nestedProperties) {
    const nestedKeys = Object.keys(nestedProperties)
    if (nestedKeys.length !== 1) return null
    const nestedField = nestedKeys[0]
    if (!nestedField) return null
    const nestedProperty = asRecord(nestedProperties[nestedField])
    if (!nestedProperty) return null
    const nestedRequiredFields = getRequiredFields(property)
    return {
      property: nestedProperty,
      field: nestedField,
      containerField: field,
      required: requiredFields.has(field) || nestedRequiredFields.has(nestedField),
    }
  }

  return {
    property,
    field,
    required: requiredFields.has(field),
  }
}

function getOptionsFromChoiceProperty(property: Record<string, unknown>): ElicitationOption[] {
  const enumValues = getStringArray(property.enum)
  if (enumValues.length > 0) {
    const enumNames = getStringArray(property.enumNames)
    return enumValues.map((value, index) => ({
      value,
      label: enumNames[index] || value,
    }))
  }

  const choiceList = Array.isArray(property.oneOf)
    ? property.oneOf
    : Array.isArray(property.anyOf)
      ? property.anyOf
      : []
  return choiceList
    .map((entry) => {
      const option = asRecord(entry)
      const value = getString(option?.const)
      if (!value) return null
      return {
        value,
        label: getString(option?.title) || value,
      }
    })
    .filter((entry): entry is ElicitationOption => Boolean(entry))
}

function inferTextRenderer(interaction: SdkElicitationInteraction, context: PropertyContext): ElicitationRenderer | null {
  const { property, field, containerField, required } = context
  const type = getString(property.type)
  if (type !== 'string' && type !== 'number' && type !== 'integer') return null
  const options = getOptionsFromChoiceProperty(property)
  if (options.length > 0) return null

  const defaultValue = type === 'string'
    ? getString(property.default)
    : getNumber(property.default)

  const placeholder = type === 'string'
    ? property.format === 'email'
      ? 'name@example.com'
      : property.format === 'uri'
        ? 'https://example.com'
        : property.format === 'date'
          ? '2026-04-10'
          : property.format === 'date-time'
            ? '2026-04-10T15:00:00Z'
            : undefined
    : undefined

  return {
    type: 'form_text',
    title: makeTitle(interaction, property),
    description: makeDescription(interaction, property),
    field,
    ...(containerField ? { containerField } : {}),
    valueType: type,
    ...(defaultValue !== undefined ? { defaultValue } : {}),
    required,
    ...(getString(property.format) ? { format: getString(property.format) } : {}),
    ...(getNumber(property.minLength) !== undefined ? { minLength: getNumber(property.minLength) } : {}),
    ...(getNumber(property.maxLength) !== undefined ? { maxLength: getNumber(property.maxLength) } : {}),
    ...(getNumber(property.minimum) !== undefined ? { minimum: getNumber(property.minimum) } : {}),
    ...(getNumber(property.maximum) !== undefined ? { maximum: getNumber(property.maximum) } : {}),
    ...(placeholder ? { placeholder } : {}),
  }
}

function inferFormField(interaction: SdkElicitationInteraction, field: string, property: Record<string, unknown>, required: boolean): ElicitationFormField | null {
  const type = getString(property.type)
  const label = getString(property.title) || field
  const description = makeDescription(interaction, property)

  if (type === 'boolean') {
    return {
      type: 'boolean',
      field,
      label,
      ...(description ? { description } : {}),
      ...(getBoolean(property.default) !== undefined ? { defaultValue: getBoolean(property.default) } : {}),
      required,
    }
  }

  if (type === 'array') {
    const items = asRecord(property.items)
    if (!items) return null
    const options = getOptionsFromChoiceProperty(items)
    if (options.length === 0) return null
    const defaultValue = Array.isArray(property.default)
      ? property.default.filter((entry): entry is string => typeof entry === 'string')
      : undefined
    return {
      type: 'multi_select',
      field,
      label,
      ...(description ? { description } : {}),
      options,
      ...(defaultValue ? { defaultValue } : {}),
      required,
      ...(getNumber(property.minItems) !== undefined ? { minSelections: getNumber(property.minItems) } : {}),
      ...(getNumber(property.maxItems) !== undefined ? { maxSelections: getNumber(property.maxItems) } : {}),
    }
  }

  if (type === 'string') {
    const options = getOptionsFromChoiceProperty(property)
    if (options.length > 0) {
      return {
        type: 'single_select',
        field,
        label,
        ...(description ? { description } : {}),
        options,
        ...(getString(property.default) ? { defaultValue: getString(property.default) } : {}),
        required,
      }
    }
  }

  if (type === 'string' || type === 'number' || type === 'integer') {
    const defaultValue = type === 'string'
      ? getString(property.default)
      : getNumber(property.default)

    const placeholder = type === 'string'
      ? property.format === 'email'
        ? 'name@example.com'
        : property.format === 'uri'
          ? 'https://example.com'
          : property.format === 'date'
            ? '2026-04-10'
            : property.format === 'date-time'
              ? '2026-04-10T15:00:00Z'
              : undefined
      : undefined

    const maxLength = getNumber(property.maxLength)
    const multiline = type === 'string' && (maxLength !== undefined ? maxLength >= 200 : false)
    return {
      type: 'text',
      field,
      label,
      ...(description ? { description } : {}),
      valueType: type,
      ...(defaultValue !== undefined ? { defaultValue } : {}),
      required,
      ...(getString(property.format) ? { format: getString(property.format) } : {}),
      ...(getString(property.pattern) ? { pattern: getString(property.pattern) } : {}),
      ...(getNumber(property.minLength) !== undefined ? { minLength: getNumber(property.minLength) } : {}),
      ...(getNumber(property.maxLength) !== undefined ? { maxLength } : {}),
      ...(getNumber(property.minimum) !== undefined ? { minimum: getNumber(property.minimum) } : {}),
      ...(getNumber(property.maximum) !== undefined ? { maximum: getNumber(property.maximum) } : {}),
      ...(placeholder ? { placeholder } : {}),
      ...(multiline ? { multiline } : {}),
    }
  }

  return null
}

function inferBooleanRenderer(interaction: SdkElicitationInteraction, context: PropertyContext): ElicitationRenderer | null {
  const { property, field, containerField, required } = context
  if (property.type !== 'boolean') return null

  return {
    type: 'form_boolean',
    title: makeTitle(interaction, property),
    description: makeDescription(interaction, property),
    field,
    ...(containerField ? { containerField } : {}),
    ...(getBoolean(property.default) !== undefined ? { defaultValue: getBoolean(property.default) } : {}),
    required,
  }
}

function inferSingleSelectRenderer(interaction: SdkElicitationInteraction, context: PropertyContext): ElicitationRenderer | null {
  const { property, field, containerField, required } = context
  if (property.type !== 'string') return null
  const options = getOptionsFromChoiceProperty(property)
  if (options.length === 0) return null

  return {
    type: 'form_single_select',
    title: makeTitle(interaction, property),
    description: makeDescription(interaction, property),
    field,
    ...(containerField ? { containerField } : {}),
    options,
    ...(getString(property.default) ? { defaultValue: getString(property.default) } : {}),
    required,
  }
}

function inferMultiSelectRenderer(interaction: SdkElicitationInteraction, context: PropertyContext): ElicitationRenderer | null {
  const { property, field, containerField, required } = context
  if (property.type !== 'array') return null
  const items = asRecord(property.items)
  if (!items) return null
  const options = getOptionsFromChoiceProperty(items)
  if (options.length === 0) return null

  const defaultValue = Array.isArray(property.default)
    ? property.default.filter((entry): entry is string => typeof entry === 'string')
    : undefined

  return {
    type: 'form_multi_select',
    title: makeTitle(interaction, property),
    description: makeDescription(interaction, property),
    field,
    ...(containerField ? { containerField } : {}),
    options,
    ...(defaultValue ? { defaultValue } : {}),
    required,
    ...(getNumber(property.minItems) !== undefined ? { minSelections: getNumber(property.minItems) } : {}),
    ...(getNumber(property.maxItems) !== undefined ? { maxSelections: getNumber(property.maxItems) } : {}),
  }
}

export function inferElicitationRenderer(interaction: SdkElicitationInteraction): ElicitationRenderer {
  const url = getString(interaction.url)
  if (interaction.mode === 'url' || url) {
    return {
      type: 'url_open',
      title: interaction.message || interaction.serverName || 'Open interaction URL',
      ...(interaction.message && interaction.message !== interaction.serverName
        ? { description: interaction.message }
        : {}),
      url: url || '',
    }
  }

  const multi = getMultiPropertyContext(interaction)
  if (!multi) {
    return {
      type: 'generic_json_fallback',
      title: interaction.message || interaction.serverName || 'Interaction required',
      description: interaction.message || undefined,
    }
  }

  const fields: ElicitationFormField[] = []
  for (const [field, property] of Object.entries(multi.properties)) {
    const required = multi.requiredFields.has(field)
    const inferred = inferFormField(interaction, field, property, required)
    if (!inferred) {
      return {
        type: 'generic_json_fallback',
        title: interaction.message || interaction.serverName || 'Interaction required',
        description: interaction.message || undefined,
      }
    }
    fields.push(inferred)
  }

  // Preserve the old single-field renderer types for compatibility (and to keep
  // the UI simpler for the most common case).
  if (fields.length === 1) {
    const context = getSinglePropertyContext(interaction)
    if (context) {
      return inferMultiSelectRenderer(interaction, context)
        || inferSingleSelectRenderer(interaction, context)
        || inferBooleanRenderer(interaction, context)
        || inferTextRenderer(interaction, context)
        || {
          type: 'generic_json_fallback',
          title: interaction.message || interaction.serverName || 'Interaction required',
          description: interaction.message || undefined,
        }
    }
  }

  return {
    type: 'form_object',
    title: interaction.message || interaction.serverName || 'Interaction required',
    description: interaction.message || undefined,
    fields,
    ...(multi.containerField ? { containerField: multi.containerField } : {}),
  }
}

export function buildElicitationContent(
  renderer: Extract<ElicitationRenderer, { type: 'form_text' | 'form_boolean' | 'form_single_select' | 'form_multi_select' }>,
  value: string | number | boolean | string[],
): Record<string, unknown> {
  if (renderer.containerField) {
    return {
      [renderer.containerField]: {
        [renderer.field]: value,
      },
    }
  }

  return {
    [renderer.field]: value,
  }
}

export function buildElicitationContentForObject(
  renderer: Extract<ElicitationRenderer, { type: 'form_object' }>,
  values: Record<string, unknown>,
): Record<string, unknown> {
  if (renderer.containerField) {
    return { [renderer.containerField]: values }
  }
  return values
}
