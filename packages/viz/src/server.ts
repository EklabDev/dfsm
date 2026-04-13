import express from 'express'
import { MongoClient } from 'mongodb'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Workflow instances use a string business id as `_id`, not ObjectId. */
interface WorkflowStateDoc {
  _id: string
  history?: Array<{ contextSnapshot?: Record<string, unknown> }>
}

export async function startServer(port = 4242, mongoUri?: string): Promise<void> {
  const app = express()
  app.use(express.json())

  const uri = mongoUri ?? process.env.MONGO_URI ?? 'mongodb://localhost:27017/dfsm'
  const client = new MongoClient(uri)
  await client.connect()
  const db = client.db()

  app.get('/api/graph/:machineId', async (req, res) => {
    const doc = await db
      .collection('machine_registry')
      .findOne({ machineId: req.params.machineId, status: 'active' })
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

  app.get('/api/live/:machineId', async (req, res) => {
    const pipeline = [
      { $match: { machineId: req.params.machineId, status: 'active' } },
      { $group: { _id: '$currentState', count: { $sum: 1 } } },
    ]
    const agg = await db
      .collection('workflow_state')
      .aggregate(pipeline)
      .toArray()

    const counts: Record<string, number> = {}
    let total = 0
    for (const entry of agg) {
      counts[entry._id as string] = entry.count
      total += entry.count
    }
    res.json({ counts, total })
  })

  app.get('/api/workflow/:workflowId', async (req, res) => {
    const doc = await db
      .collection<WorkflowStateDoc>('workflow_state')
      .findOne({ _id: req.params.workflowId })
    if (!doc) {
      res.status(404).json({ error: `Workflow '${req.params.workflowId}' not found` })
      return
    }
    res.json(doc)
  })

  app.get('/api/workflow/:workflowId/diff/:index', async (req, res) => {
    const doc = await db
      .collection<WorkflowStateDoc>('workflow_state')
      .findOne({ _id: req.params.workflowId })
    if (!doc) {
      res.status(404).json({ error: 'Workflow not found' })
      return
    }

    const idx = parseInt(req.params.index, 10)
    const history = doc.history ?? []
    if (idx < 0 || idx >= history.length) {
      res.status(400).json({ error: 'Index out of range' })
      return
    }

    const current = history[idx].contextSnapshot ?? {}
    const previous = idx > 0 ? history[idx - 1].contextSnapshot ?? {} : {}

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

  // Serve static SPA
  app.use(express.static(resolve(__dirname, '../dist/client')))
  app.get('*', (_req, res) => {
    res.sendFile(resolve(__dirname, '../dist/client/index.html'))
  })

  app.listen(port, () => {
    console.log(`dfsm viz running at http://localhost:${port}`)
  })
}
