import React, { useState } from 'react'
import type { ModelInfo, ProviderType } from '@roy/core'
import { CostCalculator } from '@roy/core'

export interface ModelPickerProps {
  models: ModelInfo[]
  selectedModelId: string
  onSelect: (model: ModelInfo) => void
  className?: string
}

const PROVIDER_LABELS: Record<ProviderType, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Google',
  ollama: 'Ollama (local)',
  openrouter: 'OpenRouter',
}

export function ModelPicker({ models, selectedModelId, onSelect, className }: ModelPickerProps) {
  const [open, setOpen] = useState(false)
  const selected = models.find((m) => m.id === selectedModelId)

  const grouped = models.reduce<Record<string, ModelInfo[]>>((acc, m) => {
    const key = PROVIDER_LABELS[m.provider] ?? m.provider
    ;(acc[key] ??= []).push(m)
    return acc
  }, {})

  return (
    <div className={`relative ${className ?? ''}`}>
      {/* Trigger */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground transition-colors"
      >
        <span className="font-medium">{selected?.name ?? 'Select model'}</span>
        {selected && (
          <span className="text-xs text-muted-foreground font-mono">
            ${selected.inputPricePerMillion}/M in · ${selected.outputPricePerMillion}/M out
          </span>
        )}
        <svg className="w-4 h-4 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute z-50 top-full mt-1 left-0 w-80 rounded-md border border-border bg-popover shadow-md">
          {Object.entries(grouped).map(([provider, providerModels]) => (
            <div key={provider}>
              <div className="px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide border-b border-border">
                {provider}
              </div>
              {providerModels.map((model) => (
                <button
                  key={model.id}
                  onClick={() => { onSelect(model); setOpen(false) }}
                  className={`w-full text-left px-3 py-2.5 flex items-center justify-between hover:bg-accent text-sm transition-colors ${
                    model.id === selectedModelId ? 'bg-accent/50' : ''
                  }`}
                >
                  <div>
                    <div className="font-medium">{model.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {(model.contextWindow / 1000).toFixed(0)}K ctx
                      {model.supportsToolUse ? ' · tools' : ''}
                    </div>
                  </div>
                  <div className="text-right text-xs text-muted-foreground font-mono">
                    {model.inputPricePerMillion === 0 ? (
                      <span className="text-green-600 font-semibold">free</span>
                    ) : (
                      <>
                        <div>${model.inputPricePerMillion}/M</div>
                        <div>${model.outputPricePerMillion}/M</div>
                      </>
                    )}
                  </div>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
