import { z } from 'zod'

// ─── Tool call / result ───────────────────────────────────────────────────────

export interface ToolCall {
  id: string
  name: string
  /** Raw JSON string of arguments */
  arguments: string
}

export interface ToolResult {
  toolCallId: string
  name: string
  /** JSON-serializable result */
  result: unknown
  isError?: boolean
}

// ─── Tool definition ─────────────────────────────────────────────────────────

/**
 * A strongly-typed, Zod-validated tool definition.
 *
 * @typeParam TInput  - Zod schema type for the tool's input arguments
 * @typeParam TOutput - Return type of the tool's execute function
 *
 * @example
 * ```ts
 * const searchTool = defineTool({
 *   name: 'search',
 *   description: 'Search the web for information',
 *   parameters: z.object({ query: z.string(), maxResults: z.number().default(5) }),
 *   execute: async ({ query, maxResults }) => {
 *     const results = await webSearch(query, maxResults)
 *     return results
 *   },
 * })
 * ```
 */
export interface ToolDefinition<TSchema extends z.ZodTypeAny = z.ZodTypeAny, TOutput = unknown> {
  /** Unique name — used by the LLM to invoke this tool */
  name: string
  description: string
  parameters: TSchema
  /**
   * The actual function to run when the tool is called.
   * Receives parsed + validated input according to `parameters`.
   */
  execute: (input: z.infer<TSchema>) => Promise<TOutput>
  /**
   * Descriptor ID for serialization. If not supplied, defaults to `name`.
   * The registry uses this to reconstruct tools from persisted sessions.
   */
  descriptorId?: string
}

/**
 * Helper to define a tool with full type inference.
 */
export function defineTool<TSchema extends z.ZodTypeAny, TOutput = unknown>(
  definition: ToolDefinition<TSchema, TOutput>,
): ToolDefinition<TSchema, TOutput> {
  return definition
}

// ─── Tool registry ────────────────────────────────────────────────────────────

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>()

  register(tool: ToolDefinition): this {
    this.tools.set(tool.descriptorId ?? tool.name, tool)
    return this
  }

  get(nameOrDescriptorId: string): ToolDefinition | undefined {
    return this.tools.get(nameOrDescriptorId)
  }

  all(): ToolDefinition[] {
    return [...this.tools.values()]
  }
}
