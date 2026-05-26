import type { Message } from '../types/message.js'

export function estimatePromptTokens(messages: Message[], systemPrompt?: string): number {
  const text = [
    systemPrompt ?? '',
    ...messages.map((m) => m.content.map(serializeContentBlock).filter(Boolean).join(' ')),
  ].join(' ')
  return Math.ceil(text.length / 4)
}

function serializeContentBlock(block: Message['content'][number]): string {
  switch (block.type) {
    case 'text':
      return block.text
    case 'summary':
      return block.text
    case 'tool_call':
      return `${block.toolCall.name} ${block.toolCall.arguments}`
    case 'tool_result':
      return `${block.toolResult.name} ${serializeToolResult(block.toolResult.result)}`
  }
}

function serializeToolResult(result: unknown): string {
  if (typeof result === 'string') return result
  try {
    return JSON.stringify(result)
  } catch {
    return String(result)
  }
}
