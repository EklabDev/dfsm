import React, { useState, useEffect } from 'react'
import { StatechartCanvas } from './StatechartCanvas.js'
import { LiveOverlay } from './LiveOverlay.js'
import { HistoryPanel } from './HistoryPanel.js'

type ViewMode = 'machine' | 'workflow'

interface VizGraph {
  nodes: any[]
  edges: any[]
  machineId?: string
  workflowId?: string
  version: number
}

export function App() {
  const [viewMode, setViewMode] = useState<ViewMode>('machine')
  const [resourceId, setResourceId] = useState('order')
  const [graph, setGraph] = useState<VizGraph | null>(null)
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null)

  useEffect(() => {
    const endpoint =
      viewMode === 'machine'
        ? `/api/graph/${resourceId}`
        : `/api/workflow-graph/${resourceId}`
    fetch(endpoint)
      .then((r) => r.json())
      .then(setGraph)
      .catch(console.error)
  }, [resourceId, viewMode])

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: '1rem' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1rem' }}>
        <h1 style={{ margin: 0, fontSize: '1.5rem' }}>dfsm viz</h1>
        <select
          value={viewMode}
          onChange={(e) => setViewMode(e.target.value as ViewMode)}
          style={{ padding: '0.25rem 0.5rem', borderRadius: 4, border: '1px solid #ccc' }}
        >
          <option value="machine">Machine</option>
          <option value="workflow">Workflow route</option>
        </select>
        <input
          type="text"
          value={resourceId}
          onChange={(e) => setResourceId(e.target.value)}
          placeholder={viewMode === 'machine' ? 'Machine ID' : 'Workflow ID'}
          style={{ padding: '0.25rem 0.5rem', borderRadius: 4, border: '1px solid #ccc' }}
        />
      </header>

      {graph ? (
        <div style={{ display: 'flex', gap: '1rem' }}>
          <div style={{ flex: 2, position: 'relative' }}>
            <StatechartCanvas graph={graph} />
            {viewMode === 'machine' && <LiveOverlay machineId={resourceId} />}
          </div>
          <div style={{ flex: 1 }}>
            <label>
              Workflow ID:
              <input
                type="text"
                value={selectedWorkflowId ?? ''}
                onChange={(e) => setSelectedWorkflowId(e.target.value || null)}
                placeholder="e.g. ORD-001"
                style={{ display: 'block', width: '100%', padding: '0.25rem', marginTop: '0.25rem' }}
              />
            </label>
            {selectedWorkflowId && (
              <HistoryPanel workflowId={selectedWorkflowId} />
            )}
          </div>
        </div>
      ) : (
        <p>Loading {viewMode} graph for "{resourceId}"...</p>
      )}
    </div>
  )
}
