import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { zodToObjectJsonSchema } from '../src/providers/json-schema.js'

describe('zodToObjectJsonSchema', () => {
  it('converts nested Zod objects with descriptions, defaults, arrays, and nullable fields', () => {
    const out = zodToObjectJsonSchema(
      z.object({
        query: z.string().describe('Search query'),
        limit: z.number().int().optional(),
        tags: z.array(z.string()).default([]),
        filters: z.object({
          includeDrafts: z.boolean().nullable(),
        }),
      }),
    )

    expect(out).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'integer' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          default: [],
        },
        filters: {
          type: 'object',
          properties: {
            includeDrafts: { type: ['boolean', 'null'] },
          },
          required: ['includeDrafts'],
          additionalProperties: false,
        },
      },
      required: ['query', 'filters'],
    })
    expect(out).not.toHaveProperty('$schema')
  })

  it('throws for non-object tool parameter schemas', () => {
    expect(() => zodToObjectJsonSchema(z.string())).toThrow(
      'Tool parameters must be a z.object',
    )
  })
})
