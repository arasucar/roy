// ─── Main entry point ─────────────────────────────────────────────────────────
export { createChat, Roy } from './chat.js'
export type { RoyConfig, SendOptions, RoyEvents } from './chat.js'

// ─── Types ────────────────────────────────────────────────────────────────────
export type {
  Role,
  Message,
  ContentBlock,
  TextContent,
  SummaryContent,
  StreamChunk,
  TextChunk,
  DoneChunk,
  UsageChunk,
  CostSnapshot,
} from './types/message.js'

export { defineTool, ToolRegistry } from './types/tool.js'
export type { ToolDefinition, ToolCall, ToolResult } from './types/tool.js'

export type {
  AgentDefinition,
  CompactionConfig,
  CycleConfig,
  PlanDocument,
  PlanStep,
  PlanApprovalCallback,
} from './types/agent.js'

export type {
  ChatSession,
  BranchOptions,
  StorageAdapter,
} from './types/session.js'

export type {
  ProviderConfig,
  AnthropicConfig,
  OpenAIConfig,
  GeminiConfig,
  OllamaConfig,
  OpenRouterConfig,
  ModelInfo,
  ProviderType,
} from './types/provider.js'

export type {
  MemoryConfig,
  MemorySchema,
  MemorySlot,
  MemoryMarker,
  MemoryStorageAdapter,
  MemoryEntry,
  GlobalMemory,
} from './types/memory.js'

// ─── Providers ────────────────────────────────────────────────────────────────
export {
  AnthropicProvider,
  OpenAIProvider,
  GeminiProvider,
  OllamaProvider,
  OpenRouterProvider,
  createProvider,
} from './providers/index.js'

// ─── Session stores ───────────────────────────────────────────────────────────
export { MemoryStore, FileStore } from './session/index.js'

// ─── Compaction ───────────────────────────────────────────────────────────────
export {
  RollingCompactor,
  SummarizationStrategy,
  SlidingWindowStrategy,
  InMemoryMemoryStore,
} from './context/index.js'
export type { CompactionStrategy, CompactionEvent, SessionRolloverEvent } from './context/index.js'

// ─── Agents ───────────────────────────────────────────────────────────────────
export { AgentRegistry, Orchestrator, CycleEngine, CycleEngineError } from './agents/index.js'

// ─── Cost ─────────────────────────────────────────────────────────────────────
export { CostCalculator, MODEL_PRICING } from './cost/index.js'
export type { TurnCost, SessionCostSummary } from './cost/index.js'
