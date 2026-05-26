import type { z } from 'zod'

export interface ObjectJsonSchema extends Record<string, unknown> {
  type: 'object'
  properties: Record<string, unknown>
  required: string[]
}

// Minimal Zod -> JSON Schema conversion for OpenAI-compatible tool definitions.
export function zodToObjectJsonSchema(schema: z.ZodTypeAny): ObjectJsonSchema {
  const shapeDef = (
    schema as {
      _def?: {
        shape?: Record<string, unknown> | (() => Record<string, unknown>)
      }
    }
  )._def?.shape
  const shape = typeof shapeDef === 'function' ? shapeDef() : (shapeDef ?? {})
  const properties: Record<string, unknown> = {}
  const required: string[] = []

  for (const [key, value] of Object.entries(shape)) {
    const def = (value as { _def?: { typeName?: string } })._def
    const unwrapped = unwrapZodDef(value)
    properties[key] = { type: zodTypeName(unwrapped) }
    if (
      !def?.typeName?.includes('Optional') &&
      !def?.typeName?.includes('Default')
    ) {
      required.push(key)
    }
  }

  return { type: 'object', properties, required }
}

function unwrapZodDef(value: unknown): { typeName?: string } | undefined {
  let current = value as { _def?: { typeName?: string; innerType?: unknown } }
  while (
    current._def?.innerType !== undefined &&
    (current._def.typeName?.includes('Optional') ||
      current._def.typeName?.includes('Default') ||
      current._def.typeName?.includes('Nullable'))
  ) {
    current = current._def.innerType as {
      _def?: { typeName?: string; innerType?: unknown }
    }
  }
  return current._def
}

function zodTypeName(def: { typeName?: string } | undefined): string {
  const name: string = def?.typeName ?? ''
  if (name.includes('String')) return 'string'
  if (name.includes('Number')) return 'number'
  if (name.includes('Boolean')) return 'boolean'
  if (name.includes('Array')) return 'array'
  return 'string'
}
