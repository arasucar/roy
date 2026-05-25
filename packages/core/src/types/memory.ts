import { z } from 'zod'

// ─── Memory importance marker ─────────────────────────────────────────────────

/**
 * A marker that can be attached to any message to flag it for
 * memory extraction during compaction passes.
 */
export interface MemoryMarker {
  /** Which memory schema slots this message contributes to */
  slots: string[]
  /** Importance weight (0–1). Higher = more likely to survive aggressive compaction. */
  weight?: number
  /** Optional reason the message was marked — useful for debugging */
  reason?: string
}

// ─── Memory schema ────────────────────────────────────────────────────────────

/**
 * A single named slot in the memory schema.
 * Each slot defines a category of information worth preserving.
 *
 * @example
 * ```ts
 * {
 *   name: 'user_preferences',
 *   description: 'Explicit preferences and constraints stated by the user',
 *   schema: z.object({
 *     preferredLanguage: z.string().optional(),
 *     outputFormat: z.enum(['markdown', 'plain', 'json']).optional(),
 *     verbosity: z.enum(['concise', 'detailed']).optional(),
 *   }),
 *   extractionPrompt: 'Extract any user preferences about output format, language, or verbosity.',
 * }
 * ```
 */
export interface MemorySlot<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  /** Unique name for this slot — used in MemoryMarker.slots */
  name: string
  description: string
  /**
   * Zod schema for the data this slot holds.
   * Roy validates extracted data against this schema before storing.
   */
  schema: TSchema
  /**
   * Custom extraction prompt appended when the compactor asks the LLM to
   * extract information for this slot. Falls back to `description` if omitted.
   */
  extractionPrompt?: string
  /**
   * Merge strategy when new data is extracted for this slot.
   * - 'replace': overwrite the previous value entirely
   * - 'merge': deep-merge with the existing value (objects only)
   * - 'append': push to an array (only valid if schema is z.array)
   */
  mergeStrategy?: 'replace' | 'merge' | 'append'
}

/**
 * Defines what types of information the memory system should preserve
 * across compaction passes and session rollovers.
 *
 * @example
 * ```ts
 * const memorySchema: MemorySchema = {
 *   slots: [
 *     {
 *       name: 'decisions',
 *       description: 'Key decisions made by the user or the agent',
 *       schema: z.array(z.object({ decision: z.string(), rationale: z.string() })),
 *       mergeStrategy: 'append',
 *     },
 *     {
 *       name: 'user_preferences',
 *       description: 'User-stated preferences and constraints',
 *       schema: z.object({ tone: z.string().optional(), format: z.string().optional() }),
 *       mergeStrategy: 'merge',
 *     },
 *   ],
 * }
 * ```
 */
export interface MemorySchema {
  slots: MemorySlot[]
}

// ─── Memory entry ─────────────────────────────────────────────────────────────

export interface MemoryEntry {
  slotName: string
  value: unknown
  /** Session IDs that contributed to this entry */
  sourceSessionIds: string[]
  /** Message IDs that were marked and contributed to this entry */
  sourceMessageIds: string[]
  createdAt: string
  updatedAt: string
}

// ─── Global memory store ─────────────────────────────────────────────────────

/**
 * GlobalMemory is a cross-agent, cross-session knowledge store.
 * It survives compaction and session rollovers.
 *
 * - Agents can read from it to gain context on first message.
 * - The compaction system writes to it automatically when marked messages
 *   are compacted away.
 * - Host apps can read/write it directly for pre-seeding.
 *
 * @example
 * ```ts
 * const chat = createChat({
 *   agents: [myAgent],
 *   memory: {
 *     schema: memorySchema,
 *     store: new FileMemoryStore('./roy-memory.json'),
 *   },
 * })
 * ```
 */
export interface GlobalMemory {
  entries: Map<string, MemoryEntry>
}

// ─── Memory storage adapter ───────────────────────────────────────────────────

export interface MemoryStorageAdapter {
  load(): Promise<GlobalMemory>
  save(memory: GlobalMemory): Promise<void>
  getSlot(slotName: string): Promise<MemoryEntry | undefined>
  setSlot(slotName: string, entry: MemoryEntry): Promise<void>
}

// ─── Memory config (passed to createChat) ────────────────────────────────────

export interface MemoryConfig {
  /** Defines what information to extract and preserve */
  schema: MemorySchema
  /** Where to persist the memory. Defaults to in-memory (lost on process restart). */
  store?: MemoryStorageAdapter
  /**
   * If true, Roy will automatically inject a memory summary into each agent's
   * system prompt at the start of every session. Default: true
   */
  injectIntoSystemPrompt?: boolean
  /**
   * Custom template for injecting memory into system prompts.
   * Use {{memory}} as the placeholder.
   * Default: "Relevant context from previous sessions:\n{{memory}}"
   */
  systemPromptTemplate?: string
}
