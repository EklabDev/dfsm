import React, { useState, useEffect } from 'react'

interface Props {
  machineId: string
}

export function LiveOverlay({ machineId }: Props) {
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [total, setTotal] = useState(0)

  useEffect(() => {
    const fetchLive = () => {
      fetch(`/api/live/${machineId}`)
        .then((r) => r.json())
        .then((data) => {
          setCounts(data.counts)
          setTotal(data.total)
        })
        .catch(console.error)
    }

    fetchLive()
    const interval = setInterval(fetchLive, 3000)
    return () => clearInterval(interval)
  }, [machineId])

  if (total === 0) return null

  return (
    <div
      style={{
        position: 'absolute',
        top: 8,
        right: 8,
        background: '#fffbeb',
        border: '1px solid #f59e0b',
        borderRadius: 6,
        padding: '0.5rem',
        fontSize: '0.75rem',
      }}
    >
      <strong>Live ({total})</strong>
      {Object.entries(counts).map(([state, count]) => (
        <div key={state}>
          {state}: <strong>{count}</strong>
        </div>
      ))}
    </div>
  )
}
