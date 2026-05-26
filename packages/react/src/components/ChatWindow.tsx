import React, { useRef, useEffect, useState } from 'react'
import type { Message, StreamChunk } from '@chatroy/core'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ChatWindowProps {
  messages: Message[]
  /** Current streaming chunk (if any) */
  streamingChunk?: StreamChunk
  /** Current agent display name */
  agentName?: string
  /** Session total cost in USD */
  sessionCostUsd?: number
  /** Whether a compaction is in progress */
  isCompacting?: boolean
  /** Called when the user submits a message */
  onSend?: (input: string) => void
  className?: string
}

// ─── Minimal shadcn-compatible component ─────────────────────────────────────

export function ChatWindow({
  messages,
  streamingChunk,
  agentName,
  sessionCostUsd,
  isCompacting,
  onSend,
  className,
}: ChatWindowProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [input, setInput] = useState('')

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, streamingChunk])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim()) return
    onSend?.(input.trim())
    setInput('')
  }

  return (
    <div
      className={`flex flex-col h-full rounded-lg border border-border bg-card text-card-foreground shadow-sm ${className ?? ''}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-green-500" />
          <span className="text-sm font-semibold">{agentName ?? 'Assistant'}</span>
          {isCompacting && (
            <span className="text-xs text-muted-foreground animate-pulse">compacting…</span>
          )}
        </div>
        {sessionCostUsd !== undefined && (
          <span className="text-xs text-muted-foreground font-mono">
            ~
            {sessionCostUsd < 0.001
              ? `$${sessionCostUsd.toExponential(2)}`
              : `$${sessionCostUsd.toFixed(4)}`}
          </span>
        )}
      </div>

      {/* Message list */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {/* Streaming indicator */}
        {streamingChunk?.type === 'text' && (
          <div className="flex justify-start">
            <div className="max-w-[80%] rounded-lg px-3 py-2 bg-muted text-sm">
              <span>{streamingChunk.delta}</span>
              <span className="inline-block w-0.5 h-4 bg-current ml-0.5 animate-pulse" />
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      {onSend && (
        <form onSubmit={handleSubmit} className="border-t border-border px-4 py-3 flex gap-2">
          <input
            className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            placeholder="Message…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <button
            type="submit"
            className="inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90 h-9 px-4 py-2 text-sm font-medium transition-colors"
          >
            Send
          </button>
        </form>
      )}
    </div>
  )
}

// ─── Message bubble ───────────────────────────────────────────────────────────

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === 'user'
  const isSummary = message.content.some((b) => b.type === 'summary')
  const text = message.content
    .map((b) => {
      if (b.type === 'text') return b.text
      if (b.type === 'summary') return `[Summary: ${b.text}]`
      return ''
    })
    .join('\n')

  if (isSummary) {
    return (
      <div className="flex justify-center">
        <div className="text-xs text-muted-foreground border border-dashed border-border rounded-md px-3 py-1.5 max-w-[90%] text-center">
          📝 Context compacted — {text}
        </div>
      </div>
    )
  }

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
          isUser ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
        }`}
      >
        <p className="whitespace-pre-wrap">{text}</p>
        {message.cost && (
          <p className="text-xs opacity-60 mt-1 font-mono">
            {message.cost.promptTokens + message.cost.completionTokens} tok
          </p>
        )}
      </div>
    </div>
  )
}
