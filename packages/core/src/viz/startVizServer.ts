import express from 'express'
import type { IWorkflowStore } from '../store/IWorkflowStore.js'

export interface VizServerOptions {
  store: IWorkflowStore
  port?: number
}

export async function startVizServer(options: VizServerOptions): Promise<void> {
  const app = express()
  const { store, port = 4242 } = options

  app.get('/api/graph/:machineId', async (req, res) => {
    const doc = await store.getActiveMachine(req.params.machineId)
    if (!doc) {
      res.status(404).json({ error: `Machine '${req.params.machineId}' not found` })
      return
    }
    res.json({
      nodes: doc.vizGraph.nodes,
      edges: doc.vizGraph.edges,
      machineId: doc.machineId,
      version: doc.version,
    })
  })

  app.get('/api/workflow-graph/:workflowId', async (req, res) => {
    const doc = await store.getActiveWorkflowDefinition(req.params.workflowId)
    if (!doc) {
      res.status(404).json({ error: `Workflow '${req.params.workflowId}' not found` })
      return
    }
    res.json({
      nodes: doc.vizGraph.nodes,
      edges: doc.vizGraph.edges,
      workflowId: doc.workflowId,
      version: doc.version,
    })
  })

  app.get('/api/live/:machineId', async (req, res) => {
    const workflows = await store.getActiveWorkflowInstances(req.params.machineId)
    const counts: Record<string, number> = {}
    for (const wf of workflows) {
      counts[wf.currentState] = (counts[wf.currentState] ?? 0) + 1
    }
    res.json({ counts, total: workflows.length })
  })

  app.get('/api/workflow/:workflowId', async (req, res) => {
    const doc = await store.getWorkflowInstance(req.params.workflowId)
    if (!doc) {
      res.status(404).json({ error: `Workflow '${req.params.workflowId}' not found` })
      return
    }
    const history = await store.getWorkflowHistory(req.params.workflowId)
    res.json({ ...doc, history })
  })

  app.get('/api/workflow/:workflowId/diff/:index', async (req, res) => {
    const history = await store.getWorkflowHistory(req.params.workflowId)
    const idx = parseInt(req.params.index, 10)
    if (idx < 0 || idx >= history.length) {
      res.status(400).json({ error: 'Index out of range' })
      return
    }

    const current = history[idx]!.contextSnapshot
    const previous = idx > 0 ? history[idx - 1]!.contextSnapshot : {}

    const added: Record<string, unknown> = {}
    const changed: Record<string, { from: unknown; to: unknown }> = {}
    const removed: string[] = []

    for (const key of Object.keys(current)) {
      if (!(key in previous)) {
        added[key] = current[key]
      } else if (JSON.stringify(current[key]) !== JSON.stringify(previous[key])) {
        changed[key] = { from: previous[key], to: current[key] }
      }
    }
    for (const key of Object.keys(previous)) {
      if (!(key in current)) {
        removed.push(key)
      }
    }

    res.json({ added, changed, removed })
  })

  app.listen(port, () => {
    console.log(`dfsm viz running at http://localhost:${port}`)
  })
}
