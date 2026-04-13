import React from 'react'

interface Props {
  graph: {
    nodes: Array<{ id: string; label: string; type: string; meta: any }>
    edges: Array<{ from: string; to: string; event: string; guard?: string; actions: string[] }>
  }
}

const nodeStyles: Record<string, React.CSSProperties> = {
  initial: {
    background: '#3b82f6',
    color: 'white',
    border: '2px solid #1d4ed8',
    borderRadius: 8,
    padding: '0.5rem 1rem',
  },
  terminal: {
    background: '#f1f5f9',
    border: '3px double #64748b',
    borderRadius: 8,
    padding: '0.5rem 1rem',
  },
  state: {
    background: '#f8fafc',
    border: '1px solid #cbd5e1',
    borderRadius: 8,
    padding: '0.5rem 1rem',
  },
}

export function StatechartCanvas({ graph }: Props) {
  return (
    <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: '1rem', minHeight: 300 }}>
      <h3 style={{ margin: '0 0 1rem' }}>States</h3>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem' }}>
        {graph.nodes.map((node) => (
          <div key={node.id} style={nodeStyles[node.type] ?? nodeStyles.state}>
            <strong>{node.label}</strong>
            {node.meta?.ttlMs && (
              <div style={{ fontSize: '0.75rem', opacity: 0.7 }}>
                TTL: {node.meta.ttlMs}ms
              </div>
            )}
          </div>
        ))}
      </div>
      <h3 style={{ margin: '1rem 0 0.5rem' }}>Transitions</h3>
      <ul style={{ margin: 0, paddingLeft: '1.5rem', fontSize: '0.875rem' }}>
        {graph.edges.map((edge, i) => (
          <li key={i}>
            <strong>{edge.from}</strong> →{' '}
            <strong>{edge.to}</strong>{' '}
            <code>{edge.event}</code>
            {edge.guard && <span> [{edge.guard}]</span>}
            {edge.actions.length > 0 && (
              <span style={{ color: '#6b7280' }}> / {edge.actions.join(', ')}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
