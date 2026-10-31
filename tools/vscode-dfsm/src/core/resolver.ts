import type { ParsedMachine, ParsedStateNode } from './types';

export interface TargetResolutionResult {
  resolved: boolean;
  targetPath?: string;
  targetNode?: ParsedStateNode;
  reason?: string;
}

/**
 * Resolves a DFSM transition `target` or `onFail.target` reference according to
 * SPECIFICATION.md Section 2.3:
 *
 * 1. `#<machineId>.<dot.path>` or `#<dot.path>`:
 *    Resolves directly from the root machine (including `#error` and `#<machineId>.error`).
 * 2. Relative dot-path (`parent.child`):
 *    Resolves relative to the source state's parent container, falling back to root `states`.
 * 3. Sibling key (`charged`):
 *    Resolves to the sibling state inside the same parent `states` map, falling back
 *    to root `states` (including the implicit or overridden root `error` state).
 */
export function resolveStateTarget(
  machine: ParsedMachine,
  sourceStatePath: string | null,
  rawTarget: string
): TargetResolutionResult {
  const target = rawTarget.trim();
  if (!target) {
    return { resolved: false, reason: 'Target state reference cannot be empty.' };
  }

  // Rule 1: ID / Root Path (`#<machineId>.<dot.path>` or `#<dot.path>`)
  if (target.startsWith('#')) {
    const rest = target.slice(1);
    if (!rest) {
      return { resolved: false, reason: `Invalid root target '${rawTarget}'.` };
    }

    if (machine.id && rest.startsWith(`${machine.id}.`)) {
      const subPath = rest.slice(machine.id.length + 1);
      const byMachineId = machine.allStatesByPath.get(subPath);
      if (byMachineId) {
        return { resolved: true, targetPath: subPath, targetNode: byMachineId };
      }
      return {
        resolved: false,
        reason: `Target '${rawTarget}' does not match any state at '${subPath}' in machine '${machine.id}'.`
      };
    }

    const byRootPath = machine.allStatesByPath.get(rest);
    if (byRootPath) {
      return { resolved: true, targetPath: rest, targetNode: byRootPath };
    }

    const dotIdx = rest.indexOf('.');
    if (dotIdx > 0 && machine.id && rest.slice(0, dotIdx) !== machine.id) {
      const candidateSubPath = rest.slice(dotIdx + 1);
      if (machine.allStatesByPath.has(candidateSubPath)) {
        return {
          resolved: false,
          reason: `Target '${rawTarget}' references machine ID '${rest.slice(0, dotIdx)}', expected '#${machine.id}.${candidateSubPath}'.`
        };
      }
    }

    return {
      resolved: false,
      reason: `Target '${rawTarget}' does not exist in machine '${machine.id ?? 'unnamed'}'.`
    };
  }

  const parentPrefix =
    sourceStatePath && sourceStatePath.includes('.')
      ? sourceStatePath.slice(0, sourceStatePath.lastIndexOf('.'))
      : '';

  // Rule 2 & Rule 3: Try relative to source state's parent container first, then fall back to root `states`
  if (parentPrefix) {
    const scopedCandidate = `${parentPrefix}.${target}`;
    const scopedMatch = machine.allStatesByPath.get(scopedCandidate);
    if (scopedMatch) {
      return { resolved: true, targetPath: scopedCandidate, targetNode: scopedMatch };
    }
  }

  const rootMatch = machine.allStatesByPath.get(target);
  if (rootMatch) {
    return { resolved: true, targetPath: target, targetNode: rootMatch };
  }

  const scopeHint = parentPrefix ? `parent '${parentPrefix}' or root 'states'` : `root 'states'`;
  return {
    resolved: false,
    reason: `Target state '${rawTarget}' was not found in ${scopeHint}.`
  };
}
