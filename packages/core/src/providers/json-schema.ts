import type { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { JsonSchema7Type } from 'zod-to-json-schema'

export interface ObjectJsonSchema extends Record<string, unknown> {
  type: 'object'
  properties: Record<string, unknown>
  required: string[]
}

// OpenAI-compatible tool parameters are JSON Schema objects. Keep the public
// helper normalized so providers don't leak converter-specific top-level fields.
export function zodToObjectJsonSchema(schema: z.ZodTypeAny): ObjectJsonSchema {
  const converted = zodToJsonSchema(schema, {
    target: 'jsonSchema7',
    $refStrategy: 'none',
  }) as JsonSchema7Type & Record<string, unknown>

  if (converted.type !== 'object') {
    throw new Error('[Roy] Tool parameters must be a z.object(...) schema.')
  }

  const {
    $schema: _schema,
    definitions: _definitions,
    type: _type,
    properties,
    required,
    ...rest
  } = converted

  return {
    ...rest,
    type: 'object',
    properties: isRecord(properties) ? properties : {},
    required: Array.isArray(required) ? required : [],
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
