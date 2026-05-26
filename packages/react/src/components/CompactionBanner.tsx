import React, { useEffect, useState } from 'react'
import type { CompactionEvent, SessionRolloverEvent } from '@chatroy/core'

// ─── Compaction toast ─────────────────────────────────────────────────────────

export interface CompactionBannerProps {
  event: CompactionEvent | null
  className?: string
}

export function CompactionBanner({ event, className }: CompactionBannerProps) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!event) return
    setVisible(true)
    const timer = setTimeout(() => setVisible(false), 4000)
    return () => clearTimeout(timer)
  }, [event])

  if (!visible || !event) return null

  return (
    <div
      className={`fixed bottom-4 right-4 z-50 flex items-start gap-3 rounded-lg border border-border bg-background p-4 shadow-lg max-w-sm animate-in slide-in-from-bottom-2 ${className ?? ''}`}
    >
      <div className="flex-shrink-0 mt-0.5">
        <svg
          className="w-4 h-4 text-amber-500"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M13 10V3L4 14h7v7l9-11h-7z"
          />
        </svg>
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">Context compacted</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          Freed ~{event.tokensFreed.toLocaleString()} tokens · {event.messagesCompacted} messages
          summarized
        </p>
      </div>
      <button
        onClick={() => setVisible(false)}
        className="flex-shrink-0 text-muted-foreground hover:text-foreground"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M6 18L18 6M6 6l12 12"
          />
        </svg>
      </button>
    </div>
  )
}

// ─── Session rollover alert ───────────────────────────────────────────────────

export interface SessionRolloverAlertProps {
  event: SessionRolloverEvent | null
  onContinue?: () => void
  className?: string
}

export function SessionRolloverAlert({ event, onContinue, className }: SessionRolloverAlertProps) {
  if (!event) return null

  return (
    <div
      className={`fixed inset-x-0 bottom-0 z-50 border-t border-amber-200 bg-amber-50 dark:bg-amber-950 dark:border-amber-800 p-4 ${className ?? ''}`}
    >
      <div className="max-w-2xl mx-auto flex items-start gap-4">
        <div className="flex-shrink-0">
          <svg
            className="w-5 h-5 text-amber-600"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
        </div>
        <div className="flex-1">
          <p className="text-sm font-semibold text-amber-800 dark:text-amber-200">
            New session started
          </p>
          <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
            The context window was full. A summary of the previous conversation has been carried
            forward. No context was lost — it was compressed into memory.
          </p>
        </div>
        {onContinue && (
          <button
            onClick={onContinue}
            className="flex-shrink-0 rounded-md bg-amber-600 text-white text-sm px-3 py-1.5 hover:bg-amber-700 transition-colors"
          >
            Continue
          </button>
        )}
      </div>
    </div>
  )
}
