import { readFileSync } from "node:fs";
import Ajv from "ajv";
import { parse as parseYaml } from "yaml";
import { MachineValidationError } from "../errors.js";
import type { PartialTransitionPolicy } from "../types.js";
import {
  createEmptyMachineHooksIR,
  finalizeAndValidateMachineIR,
  type MachineDefinition,
  type MachineHooksIR,
  type StateNodeIR,
  type StateNodeType,
  type TransitionEdgeIR,
} from "./ir.js";

const DFSM_V1_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  required: ["dfsm", "id", "states"],
  additionalProperties: false,
  properties: {
    dfsm: { type: "string", const: "1.0" },
    id: { type: "string", pattern: "^[a-zA-Z0-9_-]+$", minLength: 1 },
    version: { type: "string" },
    description: { type: "string" },
    type: { type: "string", enum: ["compound", "parallel"] },
    initial: { type: "string", minLength: 1 },
    registry: {
      type: "object",
      additionalProperties: false,
      properties: {
        namespace: { type: "string", minLength: 1 },
        strict: { type: "boolean" },
      },
    },
    defaults: { $ref: "#/definitions/TransitionPolicy" },
    hooks: { $ref: "#/definitions/MachineHooksConfig" },
    effects: {
      type: "array",
      items: { type: "string", minLength: 1 },
    },
    maxEffectChainDepth: { type: "integer", minimum: 1 },
    states: {
      type: "object",
      minProperties: 1,
      additionalProperties: { $ref: "#/definitions/StateNode" },
    },
  },
  definitions: {
    HookHandlerRef: {
      oneOf: [
        { type: "string", minLength: 1 },
        { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
      ],
    },
    MachineHooksConfig: {
      type: "object",
      additionalProperties: false,
      properties: {
        onStart: { $ref: "#/definitions/HookHandlerRef" },
        beforeTransition: { $ref: "#/definitions/HookHandlerRef" },
        afterTransition: { $ref: "#/definitions/HookHandlerRef" },
        onCompensate: { $ref: "#/definitions/HookHandlerRef" },
        onComplete: { $ref: "#/definitions/HookHandlerRef" },
        onTerminal: { $ref: "#/definitions/HookHandlerRef" },
      },
    },
    BackoffConfig: {
      type: "object",
      additionalProperties: false,
      properties: {
        strategy: {
          type: "string",
          enum: ["fixed", "linear", "exponential", "exponential_jitter"],
        },
        initialDelayMs: { type: "number", minimum: 0 },
        maxDelayMs: { type: "number", minimum: 0 },
        multiplier: { type: "number", minimum: 1 },
      },
    },
    RetryConfig: {
      type: "object",
      additionalProperties: false,
      properties: {
        maxAttempts: { type: "integer", minimum: 1 },
        backoff: { $ref: "#/definitions/BackoffConfig" },
      },
    },
    CircuitBreakerConfig: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        key: { type: "string", minLength: 1 },
        failureThreshold: { type: "integer", minimum: 1 },
        slidingWindowSize: { type: "integer", minimum: 1 },
        openDurationMs: { type: "integer", minimum: 1 },
        halfOpenMaxCalls: { type: "integer", minimum: 1 },
      },
    },
    OnFailConfig: {
      type: "object",
      additionalProperties: false,
      properties: {
        compensate: { type: "boolean" },
        target: { type: "string", minLength: 1 },
      },
    },
    BenchmarkConfig: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
      },
    },
    TransitionPolicy: {
      type: "object",
      additionalProperties: false,
      properties: {
        retry: { $ref: "#/definitions/RetryConfig" },
        circuitBreaker: { $ref: "#/definitions/CircuitBreakerConfig" },
        onFail: { $ref: "#/definitions/OnFailConfig" },
        benchmark: { $ref: "#/definitions/BenchmarkConfig" },
      },
    },
    TransitionDefinition: {
      oneOf: [
        { type: "string", minLength: 1 },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            target: { type: "string", minLength: 1 },
            transition: { type: "string", minLength: 1 },
            compensate: { type: "string", minLength: 1 },
            effects: { type: "array", items: { type: "string", minLength: 1 } },
            description: { type: "string" },
            retry: { $ref: "#/definitions/RetryConfig" },
            circuitBreaker: { $ref: "#/definitions/CircuitBreakerConfig" },
            onFail: { $ref: "#/definitions/OnFailConfig" },
            benchmark: { $ref: "#/definitions/BenchmarkConfig" },
          },
        },
      ],
    },
    StateNode: {
      type: "object",
      additionalProperties: false,
      properties: {
        type: { type: "string", enum: ["atomic", "compound", "parallel", "final"] },
        description: { type: "string" },
        initial: { type: "string", minLength: 1 },
        entry: { type: "array", items: { type: "string", minLength: 1 } },
        exit: { type: "array", items: { type: "string", minLength: 1 } },
        on: {
          type: "object",
          additionalProperties: { $ref: "#/definitions/TransitionDefinition" },
        },
        onDone: { $ref: "#/definitions/TransitionDefinition" },
        states: {
          type: "object",
          minProperties: 1,
          additionalProperties: { $ref: "#/definitions/StateNode" },
        },
      },
    },
  },
} as const;

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
const validateSchema = ajv.compile<Record<string, any>>(DFSM_V1_SCHEMA);

function extractPolicy(raw: Record<string, any> | undefined): PartialTransitionPolicy {
  if (!raw) return {};
  const policy: PartialTransitionPolicy = {};
  if (raw.retry) {
    policy.retry = {
      ...(raw.retry.maxAttempts !== undefined ? { maxAttempts: raw.retry.maxAttempts } : {}),
      ...(raw.retry.backoff
        ? {
            backoff: {
              ...(raw.retry.backoff.strategy !== undefined
                ? { strategy: raw.retry.backoff.strategy }
                : {}),
              ...(raw.retry.backoff.initialDelayMs !== undefined
                ? { initialDelayMs: raw.retry.backoff.initialDelayMs }
                : {}),
              ...(raw.retry.backoff.maxDelayMs !== undefined
                ? { maxDelayMs: raw.retry.backoff.maxDelayMs }
                : {}),
              ...(raw.retry.backoff.multiplier !== undefined
                ? { multiplier: raw.retry.backoff.multiplier }
                : {}),
            },
          }
        : {}),
    };
  }
  if (raw.circuitBreaker) {
    policy.circuitBreaker = { ...raw.circuitBreaker };
  }
  if (raw.onFail) {
    policy.onFail = { ...raw.onFail };
  }
  if (raw.benchmark) {
    policy.benchmark = { ...raw.benchmark };
  }
  if (typeof raw.compensate === "string") {
    policy.compensateHandler = raw.compensate;
  }
  return policy;
}

function parseTransitionEdge(event: string, rawDef: unknown): TransitionEdgeIR {
  if (typeof rawDef === "string") {
    return {
      event,
      target: rawDef,
      effects: [],
      policy: {},
    };
  }
  const obj = rawDef as Record<string, any>;
  return {
    event,
    target: obj.target,
    transition: obj.transition,
    compensate: obj.compensate,
    effects: Array.isArray(obj.effects) ? [...obj.effects] : [],
    description: obj.description,
    policy: extractPolicy(obj),
  };
}

function parseStateNode(key: string, parentPath: string, rawNode: Record<string, any>): StateNodeIR {
  const path = parentPath ? `${parentPath}.${key}` : key;
  const rawStates = rawNode.states as Record<string, Record<string, any>> | undefined;
  const hasChildren = rawStates !== undefined && Object.keys(rawStates).length > 0;

  const inferredType: StateNodeType =
    (rawNode.type as StateNodeType | undefined) ?? (hasChildren ? "compound" : "atomic");

  const childStates: Record<string, StateNodeIR> = {};
  if (rawStates) {
    for (const [childKey, childRaw] of Object.entries(rawStates)) {
      childStates[childKey] = parseStateNode(childKey, path, childRaw ?? {});
    }
  }

  const onEdges: Record<string, TransitionEdgeIR> = {};
  if (rawNode.on && typeof rawNode.on === "object") {
    for (const [event, edgeRaw] of Object.entries(rawNode.on)) {
      onEdges[event] = parseTransitionEdge(event, edgeRaw);
    }
  }

  return {
    key,
    path,
    type: inferredType,
    description: rawNode.description,
    initial: rawNode.initial,
    entry: Array.isArray(rawNode.entry) ? [...rawNode.entry] : [],
    exit: Array.isArray(rawNode.exit) ? [...rawNode.exit] : [],
    on: onEdges,
    onDone: rawNode.onDone ? parseTransitionEdge("$onDone", rawNode.onDone) : undefined,
    states: childStates,
  };
}

function extractHooks(rawHooks: Record<string, any> | undefined): MachineHooksIR {
  const hooks = createEmptyMachineHooksIR();
  if (!rawHooks || typeof rawHooks !== "object") return hooks;

  const toStringList = (val: unknown): string[] => {
    if (typeof val === "string") return [val];
    if (Array.isArray(val)) return val.filter((v): v is string => typeof v === "string");
    return [];
  };

  hooks.onStart = toStringList(rawHooks.onStart);
  hooks.beforeTransition = toStringList(rawHooks.beforeTransition);
  hooks.afterTransition = toStringList(rawHooks.afterTransition);
  hooks.onCompensate = toStringList(rawHooks.onCompensate);
  hooks.onComplete = toStringList(rawHooks.onComplete);
  hooks.onTerminal = toStringList(rawHooks.onTerminal);
  return hooks;
}

export function parseYamlMachine(yamlContent: string): MachineDefinition {
  let doc: unknown;
  try {
    doc = parseYaml(yamlContent);
  } catch (err) {
    throw new MachineValidationError(
      `Failed to parse DFSM YAML: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new MachineValidationError("DFSM YAML root must be a mapping object.");
  }

  const record = doc as Record<string, any>;
  if ("context" in record) {
    throw new MachineValidationError(
      "Untyped 'context' is not allowed in DFSM YAML. Define generic TContext and validation in source code.",
      ["root.context: Untyped context in YAML is disallowed; define typed TContext in code."]
    );
  }

  const valid = validateSchema(record);
  if (!valid) {
    const issues = (validateSchema.errors ?? []).map(
      (e) => `${e.instancePath || "/"} ${e.message ?? "schema violation"}`
    );
    throw new MachineValidationError(
      `DFSM YAML schema validation failed: ${issues.join("; ")}`,
      issues
    );
  }

  const states: Record<string, StateNodeIR> = {};
  for (const [stateKey, rawState] of Object.entries(record.states as Record<string, any>)) {
    states[stateKey] = parseStateNode(stateKey, "", rawState ?? {});
  }

  return finalizeAndValidateMachineIR({
    dfsm: "1.0",
    id: record.id,
    version: record.version ?? "1.0.0",
    description: record.description,
    source: "yaml",
    type: record.type ?? "compound",
    initial: record.initial,
    registry: {
      namespace: record.registry?.namespace,
      strict: record.registry?.strict ?? true,
    },
    defaults: extractPolicy(record.defaults),
    hooks: extractHooks(record.hooks),
    effects: Array.isArray(record.effects) ? [...record.effects] : [],
    ...(record.maxEffectChainDepth !== undefined
      ? { maxEffectChainDepth: record.maxEffectChainDepth }
      : {}),
    states,
  });
}

export function loadYamlMachineFromFile(filePath: string): MachineDefinition {
  const content = readFileSync(filePath, "utf8");
  return parseYamlMachine(content);
}
