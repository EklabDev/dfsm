import React, { useState, useEffect } from 'react'

interface Props {
  workflowId: string
}

interface HistoryEntry {
  transitionedAt: string
  fromState: string
  toState: string
  event: string
  actionsDispatched: string[]
}

interface DiffResult {
  added: Record<string, unknown>
  changed: Record<string, { from: unknown; to: unknown }>
  removed: string[]
}

export function HistoryPanel({ workflowId }: Props) {
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)
  const [diff, setDiff] = useState<DiffResult | null>(null)

  useEffect(() => {
    fetch(`/api/workflow/${workflowId}`)
      .then((r) => r.json())
      .then((data) => setHistory(data.history ?? []))
      .catch(console.error)
    setExpandedIdx(null)
    setDiff(null)
  }, [workflowId])

  const toggleDiff = (idx: number) => {
    if (expandedIdx === idx) {
      setExpandedIdx(null)
      setDiff(null)
      return
    }
    setExpandedIdx(idx)
    fetch(`/api/workflow/${workflowId}/diff/${idx}`)
      .then((r) => r.json())
      .then(setDiff)
      .catch(console.error)
  }

  if (history.length === 0) {
    return <p style={{ fontSize: '0.875rem', color: '#6b7280' }}>No history yet.</p>
  }

  return (
    <div style={{ marginTop: '1rem' }}>
      <h3 style={{ fontSize: '1rem', margin: '0 0 0.5rem' }}>History</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
        {history.map((entry, i) => (
          <div key={i}>
            <div
              onClick={() => toggleDiff(i)}
              style={{
                cursor: 'pointer',
                padding: '0.35rem',
                background: expandedIdx === i ? '#f0f9ff' : '#f8fafc',
                border: '1px solid #e2e8f0',
                borderRadius: 4,
                fontSize: '0.8rem',
              }}
            >
              <strong>{entry.fromState}</strong> → <strong>{entry.toState}</strong>
              <span style={{ marginLeft: '0.5rem', color: '#6b7280' }}>{entry.event}</span>
              {entry.actionsDispatched.length > 0 && (
                <span style={{ color: '#9ca3af' }}>
                  {' / '}
                  {entry.actionsDispatched.join(', ')}
                </span>
              )}
            </div>
            {expandedIdx === i && diff && (
              <div
                style={{
                  fontSize: '0.75rem',
                  padding: '0.35rem',
                  background: '#fafafa',
                  borderLeft: '3px solid #3b82f6',
                  marginTop: 2,
                }}
              >
                {Object.entries(diff.added).map(([k, v]) => (
                  <div key={k} style={{ color: '#16a34a' }}>
                    + {k}: {JSON.stringify(v)}
                  </div>
                ))}
                {Object.entries(diff.changed).map(([k, v]) => (
                  <div key={k} style={{ color: '#d97706' }}>
                    ~ {k}: {JSON.stringify(v.from)} → {JSON.stringify(v.to)}
                  </div>
                ))}
                {diff.removed.map((k) => (
                  <div key={k} style={{ color: '#dc2626' }}>
                    - {k}
                  </div>
                ))}
                {Object.keys(diff.added).length === 0 &&
                  Object.keys(diff.changed).length === 0 &&
                  diff.removed.length === 0 && (
                    <div style={{ color: '#9ca3af' }}>No context changes</div>
                  )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
