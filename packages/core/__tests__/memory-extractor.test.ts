import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  InMemoryMemoryStore,
  MemoryExtractor,
} from '../src/context/memory-extractor.js'
import type { LLMProvider, SendOptions } from '../src/providers/types.js'
import type { Message } from '../src/types/message.js'
import type { MemorySchema } from '../src/types/memory.js'

function markedMessage(slots: string[], text = 'Use concise answers'): Message {
  return {
    id: 'msg_1',
    role: 'user',
    content: [{ type: 'text', text }],
    metadata: { memoryMarker: { slots } },
    createdAt: '2026-05-26T00:00:00Z',
  }
}

class FakeExtractionProvider implements LLMProvider {
  readonly type = 'test'
  readonly calls: SendOptions[] = []

  constructor(private readonly responses: string[]) {}

  async *stream(options: SendOptions) {
    this.calls.push(options)
    yield { type: 'text' as const, delta: this.responses.shift() ?? 'null' }
  }

  estimateTokens(): number {
    return 0
  }

  contextWindowSize(): number {
    return 128_000
  }
}

describe('MemoryExtractor', () => {
  it('validates extracted JSON against the slot schema before storing it', async () => {
    const schema: MemorySchema = {
      slots: [
        {
          name: 'preferences',
          description: 'User preferences',
          schema: z.object({ tone: z.string() }),
        },
      ],
    }
    const store = new InMemoryMemoryStore()
    const extractor = new MemoryExtractor(
      schema,
      store,
      new FakeExtractionProvider(['{"tone":"concise"}']),
      'test-model',
    )

    await extractor.extractFromMessages([markedMessage(['preferences'])], 's1')

    await expect(store.getSlot('preferences')).resolves.toMatchObject({
      slotName: 'preferences',
      value: { tone: 'concise' },
      sourceSessionIds: ['s1'],
      sourceMessageIds: ['msg_1'],
    })
  })

  it('skips malformed or schema-invalid model extractions', async () => {
    const schema: MemorySchema = {
      slots: [
        {
          name: 'preferences',
          description: 'User preferences',
          schema: z.object({ tone: z.string() }),
        },
      ],
    }
    const store = new InMemoryMemoryStore()
    const extractor = new MemoryExtractor(
      schema,
      store,
      new FakeExtractionProvider(['{"tone":123}']),
      'test-model',
    )

    await extractor.extractFromMessages([markedMessage(['preferences'])], 's1')

    await expect(store.getSlot('preferences')).resolves.toBeUndefined()
  })

  it('merges validated object memories into existing slot values', async () => {
    const schema: MemorySchema = {
      slots: [
        {
          name: 'preferences',
          description: 'User preferences',
          schema: z.object({
            tone: z.string().optional(),
            format: z.string().optional(),
          }),
          mergeStrategy: 'merge',
        },
      ],
    }
    const store = new InMemoryMemoryStore()
    await store.setSlot('preferences', {
      slotName: 'preferences',
      value: { tone: 'concise' },
      sourceSessionIds: ['s0'],
      sourceMessageIds: ['old_msg'],
      createdAt: '2026-05-25T00:00:00Z',
      updatedAt: '2026-05-25T00:00:00Z',
    })
    const extractor = new MemoryExtractor(
      schema,
      store,
      new FakeExtractionProvider(['{"format":"markdown"}']),
      'test-model',
    )

    await extractor.extractFromMessages([markedMessage(['preferences'])], 's1')

    await expect(store.getSlot('preferences')).resolves.toMatchObject({
      value: { tone: 'concise', format: 'markdown' },
      sourceSessionIds: ['s0', 's1'],
      sourceMessageIds: ['old_msg', 'msg_1'],
      createdAt: '2026-05-25T00:00:00Z',
    })
  })
})
