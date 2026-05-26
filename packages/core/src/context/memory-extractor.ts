import type { Message } from '../types/message.js'
import type {
  MemorySchema,
  MemoryEntry,
  MemoryStorageAdapter,
  GlobalMemory,
} from '../types/memory.js'
import type { LLMProvider } from '../providers/types.js'
import { generateId } from '../utils/id.js'

/**
 * MemoryExtractor — runs during compaction passes.
 *
 * Before messages are compacted away, the extractor:
 * 1. Finds all messages marked with MemoryMarker metadata
 * 2. For each memory slot referenced, asks the LLM to extract relevant data
 * 3. Merges extracted data into the GlobalMemory store
 *
 * This ensures important information survives compaction.
 */
export class MemoryExtractor {
  constructor(
    private readonly schema: MemorySchema,
    private readonly store: MemoryStorageAdapter,
    private readonly provider: LLMProvider,
    private readonly model: string,
  ) {}

  /**
   * Extract memory from a set of messages that are about to be compacted.
   * Call this before running the compaction strategy.
   */
  async extractFromMessages(messages: Message[], sessionId: string): Promise<void> {
    // Find messages with memory markers
    const markedMessages = messages.filter((m) => m.metadata?.['memoryMarker'] !== undefined)

    if (markedMessages.length === 0) return

    // Group by slot name
    const slotMap = new Map<string, Message[]>()
    for (const msg of markedMessages) {
      const marker = msg.metadata?.['memoryMarker'] as { slots: string[] }
      for (const slot of marker.slots) {
        const existing = slotMap.get(slot) ?? []
        existing.push(msg)
        slotMap.set(slot, existing)
      }
    }

    // For each slot, run extraction
    for (const [slotName, slotMessages] of slotMap) {
      const slotDef = this.schema.slots.find((s) => s.name === slotName)
      if (!slotDef) continue

      const messagesText = slotMessages
        .map((m) => {
          const text = m.content
            .filter((b) => b.type === 'text')
            .map((b) => (b as any).text)
            .join('\n')
          return `[${m.role}]: ${text}`
        })
        .join('\n\n')

      const extractionPrompt = `${slotDef.extractionPrompt ?? slotDef.description}

Extract the relevant information from the following messages. Return ONLY a JSON object matching the schema. If no relevant information is found, return null.

Messages:
${messagesText}

Return JSON only:`

      let responseText = ''
      for await (const chunk of this.provider.stream({
        model: this.model,
        messages: [
          {
            id: generateId(),
            role: 'user',
            content: [{ type: 'text', text: extractionPrompt }],
            createdAt: new Date().toISOString(),
          },
        ],
      })) {
        if (chunk.type === 'text') responseText += chunk.delta
      }

      let extracted: unknown
      try {
        const jsonMatch = responseText.match(/\{[\s\S]*\}|\[[\s\S]*\]/)
        if (!jsonMatch || jsonMatch[0] === 'null') continue
        extracted = JSON.parse(jsonMatch[0])
      } catch {
        continue // skip malformed extractions
      }

      const parsed = slotDef.schema.safeParse(extracted)
      if (!parsed.success) continue
      extracted = parsed.data

      // Merge into store
      const existing = await this.store.getSlot(slotName)
      const strategy = slotDef.mergeStrategy ?? 'replace'
      const messageIds = slotMessages.map((m) => m.id)

      let newValue: unknown
      if (strategy === 'replace' || !existing) {
        newValue = extracted
      } else if (strategy === 'merge' && isRecord(extracted) && isRecord(existing.value)) {
        newValue = { ...(existing.value as object), ...(extracted as object) }
      } else if (
        strategy === 'append' &&
        Array.isArray(existing.value) &&
        Array.isArray(extracted)
      ) {
        newValue = [...existing.value, ...extracted]
      } else {
        newValue = extracted
      }

      const entry: MemoryEntry = {
        slotName,
        value: newValue,
        sourceSessionIds: [...(existing?.sourceSessionIds ?? []), sessionId].filter(
          (v, i, a) => a.indexOf(v) === i,
        ),
        sourceMessageIds: [...(existing?.sourceMessageIds ?? []), ...messageIds],
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }

      await this.store.setSlot(slotName, entry)
    }
  }

  /**
   * Format the current memory state for injection into system prompts.
   */
  async formatForSystemPrompt(template?: string): Promise<string> {
    const memory = await this.store.load()
    const lines: string[] = []

    for (const [slotName, entry] of memory.entries) {
      const slotDef = this.schema.slots.find((s) => s.name === slotName)
      const label = slotDef?.description ?? slotName
      lines.push(`${label}:\n${JSON.stringify(entry.value, null, 2)}`)
    }

    if (lines.length === 0) return ''

    const memoryText = lines.join('\n\n')
    const tmpl = template ?? 'Relevant context from previous sessions:\n{{memory}}'
    return tmpl.replace('{{memory}}', memoryText)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ─── In-memory store implementation ──────────────────────────────────────────

export class InMemoryMemoryStore implements MemoryStorageAdapter {
  private memory: GlobalMemory = { entries: new Map() }

  async load(): Promise<GlobalMemory> {
    return this.memory
  }

  async save(memory: GlobalMemory): Promise<void> {
    this.memory = memory
  }

  async getSlot(slotName: string): Promise<MemoryEntry | undefined> {
    return this.memory.entries.get(slotName)
  }

  async setSlot(slotName: string, entry: MemoryEntry): Promise<void> {
    this.memory.entries.set(slotName, entry)
  }
}
