import React, { useState } from 'react'
import type { PlanDocument, PlanStep } from '@roy/core'
import { CostCalculator } from '@roy/core'

export interface PlanApprovalProps {
  plan: PlanDocument
  /** Called when the user approves the plan */
  onApprove: () => void
  /** Called when the user rejects the plan */
  onReject: (reason?: string) => void
  className?: string
}

/**
 * PlanApproval — renders a PlanDocument as a review card.
 * The user can approve, reject, or reject with a reason.
 *
 * Wire this to Roy's `plan-ready` event:
 * ```tsx
 * roy.on('plan-ready', ({ plan }) => setCurrentPlan(plan))
 * ```
 */
export function PlanApproval({ plan, onApprove, onReject, className }: PlanApprovalProps) {
  const [rejectReason, setRejectReason] = useState('')
  const [showRejectInput, setShowRejectInput] = useState(false)
  const [isApproving, setIsApproving] = useState(false)

  const handleApprove = async () => {
    if (isApproving) return
    setIsApproving(true)
    try {
      await onApprove()
    } finally {
      setIsApproving(false)
    }
  }

  const totalMinCost = plan.steps.reduce(
    (sum, s) => sum + (s.estimatedCostUsd?.min ?? 0), 0,
  )
  const totalMaxCost = plan.steps.reduce(
    (sum, s) => sum + (s.estimatedCostUsd?.max ?? 0), 0,
  )
  const hasCostEstimate = totalMaxCost > 0

  return (
    <div
      className={`rounded-xl border border-border bg-card text-card-foreground shadow-lg overflow-hidden ${className ?? ''}`}
    >
      {/* Header */}
      <div className="bg-muted/50 px-5 py-4 border-b border-border">
        <div className="flex items-center gap-2 mb-1">
          <div className="w-2 h-2 rounded-full bg-amber-500" />
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Plan ready for approval
          </span>
        </div>
        <h2 className="text-base font-bold">{plan.title}</h2>
        <p className="text-sm text-muted-foreground mt-1">{plan.goal}</p>
      </div>

      {/* Steps */}
      <div className="px-5 py-4 space-y-3">
        {plan.steps.map((step) => (
          <PlanStepRow key={step.id} step={step} />
        ))}
      </div>

      {/* Constraints */}
      {plan.constraints && plan.constraints.length > 0 && (
        <div className="px-5 pb-4">
          <p className="text-xs font-semibold text-muted-foreground mb-2">Constraints</p>
          <ul className="space-y-1">
            {plan.constraints.map((c, i) => (
              <li key={i} className="text-xs text-muted-foreground flex gap-2">
                <span>·</span>
                <span>{c}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Cost estimate */}
      {hasCostEstimate && (
        <div className="px-5 pb-4">
          <p className="text-xs text-muted-foreground">
            Estimated cost:{' '}
            <span className="font-mono font-semibold text-foreground">
              {CostCalculator.formatCost(totalMinCost)} – {CostCalculator.formatCost(totalMaxCost)}
            </span>
          </p>
        </div>
      )}

      {/* Reject input */}
      {showRejectInput && (
        <div className="px-5 pb-4">
          <input
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            placeholder="What should be changed? (optional)"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            autoFocus
          />
        </div>
      )}

      {/* Actions */}
      <div className="px-5 py-4 border-t border-border flex gap-3 justify-end">
        {!showRejectInput ? (
          <button
            onClick={() => setShowRejectInput(true)}
            className="inline-flex items-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent transition-colors"
          >
            Reject
          </button>
        ) : (
          <button
            onClick={() => { onReject(rejectReason || undefined); setShowRejectInput(false) }}
            className="inline-flex items-center rounded-md border border-destructive text-destructive px-4 py-2 text-sm font-medium hover:bg-destructive/10 transition-colors"
          >
            Confirm reject
          </button>
        )}
        <button
          onClick={handleApprove}
          disabled={isApproving}
          aria-busy={isApproving}
          className="inline-flex items-center gap-2 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60 disabled:cursor-not-allowed px-4 py-2 text-sm font-semibold transition-colors"
        >
          {isApproving && (
            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z" />
            </svg>
          )}
          {isApproving ? 'Approving…' : 'Approve & Execute'}
        </button>
      </div>
    </div>
  )
}

// ─── Step row ─────────────────────────────────────────────────────────────────

function PlanStepRow({ step }: { step: PlanStep }) {
  return (
    <div className="flex gap-3 items-start">
      <div className="flex-shrink-0 w-6 h-6 rounded-full bg-muted flex items-center justify-center text-xs font-bold text-muted-foreground mt-0.5">
        {step.order}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium">{step.title}</p>
          {step.hasSideEffects && (
            <span className="text-xs bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200 px-1.5 py-0.5 rounded font-medium">
              side effects
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">{step.description}</p>
      </div>
      {step.estimatedCostUsd && (
        <div className="flex-shrink-0 text-xs font-mono text-muted-foreground text-right">
          {CostCalculator.formatCost(step.estimatedCostUsd.max)}
        </div>
      )}
    </div>
  )
}
