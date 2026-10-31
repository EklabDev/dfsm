import { isMap, isScalar, parseDocument } from 'yaml';

export interface DocumentDetectionInput {
  fileName: string;
  content: string;
  languageId?: string;
}

export interface DocumentDetectionResult {
  isDfsm: boolean;
  reason: 'file-extension' | 'yaml-header' | 'not-dfsm';
  machineId?: string;
}

const DFSM_EXTENSION_RE = /\.dfsm\.ya?ml$/i;
const GENERIC_YAML_RE = /\.ya?ml$/i;

/**
 * Recognizes a document as a DFSM v1.0 state machine when:
 *   a) Its file name ends with `.dfsm.yaml` or `.dfsm.yml`, OR
 *   b) It is a `.yaml` / `.yml` file (or untitled `yaml` buffer) whose parsed
 *      root YAML map contains `dfsm: "1.0"` alongside `id` and `states`.
 */
export function detectDfsmDocument(input: DocumentDetectionInput): DocumentDetectionResult {
  const normalizedName = input.fileName.trim();
  const isDfsmFileName = DFSM_EXTENSION_RE.test(normalizedName);
  const isGenericYaml =
    GENERIC_YAML_RE.test(normalizedName) ||
    (input.languageId === 'yaml' && !/\.[a-z0-9]+$/i.test(normalizedName));

  if (!isDfsmFileName && !isGenericYaml) {
    return { isDfsm: false, reason: 'not-dfsm' };
  }

  let parsedMachineId: string | undefined;
  let hasDfsmHeader = false;

  try {
    const doc = parseDocument(input.content, { prettyErrors: false });
    if (isMap(doc.contents)) {
      const dfsmNode = doc.contents.get('dfsm', true);
      const idNode = doc.contents.get('id', true);
      const statesNode = doc.contents.get('states', true);

      const dfsmVal = isScalar(dfsmNode) ? String(dfsmNode.value) : undefined;
      const rawIdVal = isScalar(idNode) ? (idNode as { value: unknown }).value : undefined;
      if (typeof rawIdVal === 'string' && rawIdVal.trim().length > 0) {
        parsedMachineId = rawIdVal.trim();
      }

      if (dfsmVal === '1.0' && parsedMachineId && isMap(statesNode)) {
        hasDfsmHeader = true;
      }
    }
  } catch {
    // Syntax errors inside `.dfsm.yaml` still count as DFSM documents via filename rule.
  }

  if (isDfsmFileName) {
    return {
      isDfsm: true,
      reason: 'file-extension',
      machineId: parsedMachineId
    };
  }

  if (hasDfsmHeader) {
    return {
      isDfsm: true,
      reason: 'yaml-header',
      machineId: parsedMachineId
    };
  }

  return { isDfsm: false, reason: 'not-dfsm' };
}

/**
 * Formats the VS Code status bar item label:
 * `$(type-hierarchy-sub) DFSM: <machineId> (<stateCount> states)`
 */
export function formatStatusBarText(machineId: string | undefined, stateCount: number): string {
  const idLabel = machineId && machineId.length > 0 ? machineId : 'unnamed';
  const noun = stateCount === 1 ? 'state' : 'states';
  return `$(type-hierarchy-sub) DFSM: ${idLabel} (${stateCount} ${noun})`;
}
