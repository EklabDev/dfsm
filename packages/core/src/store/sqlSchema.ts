export const SQL_SCHEMA = `
CREATE TABLE IF NOT EXISTS machine_definitions (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  config JSON NOT NULL,
  transition_table JSON NOT NULL,
  viz_graph JSON NOT NULL,
  topic_bindings JSON NOT NULL,
  slot_schemas JSON NOT NULL,
  status TEXT NOT NULL,
  migrated_from INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (machine_id, version)
);

CREATE TABLE IF NOT EXISTS workflow_instances (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL,
  machine_version INTEGER NOT NULL,
  current_state TEXT NOT NULL,
  context JSON NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  orchestration_id TEXT,
  orchestration_step_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_history (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  from_state TEXT,
  to_state TEXT,
  event TEXT,
  event_payload JSON,
  context_snapshot JSON,
  dispatched_actions JSON,
  created_at TEXT NOT NULL,
  UNIQUE (workflow_id, seq)
);

CREATE TABLE IF NOT EXISTS pending_actions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  action_name TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload JSON NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_definitions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  definition JSON NOT NULL,
  viz_graph JSON NOT NULL,
  entry_bindings JSON NOT NULL,
  exit_bindings JSON NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workflow_id, version)
);

CREATE TABLE IF NOT EXISTS orchestration_instances (
  id TEXT PRIMARY KEY,
  workflow_def_id TEXT NOT NULL,
  workflow_def_version INTEGER NOT NULL,
  current_step_id TEXT NOT NULL,
  context JSON NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  child_refs JSON NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_instances_machine ON workflow_instances(machine_id, status);
CREATE INDEX IF NOT EXISTS idx_workflow_instances_state ON workflow_instances(machine_id, current_state);
CREATE INDEX IF NOT EXISTS idx_pending_actions_status ON pending_actions(status, created_at);
CREATE INDEX IF NOT EXISTS idx_machine_definitions_active ON machine_definitions(machine_id, status);
`;

export const POSTGRES_SCHEMA = SQL_SCHEMA
  .replace(/JSON/g, 'JSONB')
  .replace(/TEXT NOT NULL DEFAULT 0/g, 'INTEGER NOT NULL DEFAULT 0')
