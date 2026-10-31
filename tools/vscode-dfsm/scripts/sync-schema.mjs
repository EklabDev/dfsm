import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const canonicalSchemaPath = resolve(rootDir, '../../spec/dfsm-v1.schema.json');
const bundledSchemaPath = resolve(rootDir, 'schemas/dfsm-v1.schema.json');

mkdirSync(dirname(bundledSchemaPath), { recursive: true });

if (existsSync(canonicalSchemaPath)) {
  copyFileSync(canonicalSchemaPath, bundledSchemaPath);
  console.log(`[sync-schema] Synced ${canonicalSchemaPath} -> ${bundledSchemaPath}`);
} else if (existsSync(bundledSchemaPath)) {
  console.log(`[sync-schema] Canonical spec not present outside package; keeping bundled ${bundledSchemaPath}`);
} else {
  throw new Error(`Cannot locate DFSM schema at ${canonicalSchemaPath} or ${bundledSchemaPath}`);
}
