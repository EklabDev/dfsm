export interface SourceRange {
  /** 1-based start line */
  line: number;
  /** 1-based start column */
  column: number;
  /** 1-based end line */
  endLine: number;
  /** 1-based end column */
  endColumn: number;
  /** 0-based start line (VS Code Range compatible) */
  startLine0: number;
  /** 0-based start column (VS Code Range compatible) */
  startColumn0: number;
  /** 0-based end line (VS Code Range compatible) */
  endLine0: number;
  /** 0-based end column (VS Code Range compatible) */
  endColumn0: number;
  /** 0-based start character offset */
  startOffset: number;
  /** 0-based end character offset */
  endOffset: number;
}

export type DiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint';

export interface DfsmDiagnostic {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  range: SourceRange;
  path?: string;
}

export type BackoffStrategy = 'fixed' | 'linear' | 'exponential' | 'exponential_jitter';

export interface PartialBackoffPolicy {
  strategy?: BackoffStrategy;
  initialDelayMs?: number;
  maxDelayMs?: number;
  multiplier?: number;
}

export interface PartialRetryPolicy {
  maxAttempts?: number;
  backoff?: PartialBackoffPolicy;
}

export interface PartialCircuitBreakerPolicy {
  enabled?: boolean;
  key?: string;
  failureThreshold?: number;
  slidingWindowSize?: number;
  openDurationMs?: number;
  halfOpenMaxCalls?: number;
}

export interface PartialOnFailPolicy {
  compensate?: boolean;
  target?: string;
}

export interface PartialBenchmarkPolicy {
  enabled?: boolean;
}

export interface PartialTransitionPolicy {
  retry?: PartialRetryPolicy;
  circuitBreaker?: PartialCircuitBreakerPolicy;
  onFail?: PartialOnFailPolicy;
  benchmark?: PartialBenchmarkPolicy;
}

export interface NormalizedTransitionPolicy {
  retry: {
    maxAttempts: number;
    backoff: {
      strategy: BackoffStrategy;
      initialDelayMs: number;
      maxDelayMs: number;
      multiplier: number;
    };
  };
  circuitBreaker: {
    enabled: boolean;
    key?: string;
    failureThreshold: number;
    slidingWindowSize: number;
    openDurationMs: number;
    halfOpenMaxCalls: number;
  };
  onFail: {
    compensate: boolean;
    target: string;
  };
  benchmark: {
    enabled: boolean;
  };
}

export type PolicyLayerSource = 'sdk' | 'defaults' | 'transition';

export interface PolicyFieldSources {
  'retry.maxAttempts': PolicyLayerSource;
  'retry.backoff.strategy': PolicyLayerSource;
  'retry.backoff.initialDelayMs': PolicyLayerSource;
  'retry.backoff.maxDelayMs': PolicyLayerSource;
  'retry.backoff.multiplier': PolicyLayerSource;
  'circuitBreaker.enabled': PolicyLayerSource;
  'circuitBreaker.key'?: PolicyLayerSource;
  'circuitBreaker.failureThreshold': PolicyLayerSource;
  'circuitBreaker.slidingWindowSize': PolicyLayerSource;
  'circuitBreaker.openDurationMs': PolicyLayerSource;
  'circuitBreaker.halfOpenMaxCalls': PolicyLayerSource;
  'onFail.compensate': PolicyLayerSource;
  'onFail.target': PolicyLayerSource;
  'benchmark.enabled': PolicyLayerSource;
}

export type StateNodeType = 'atomic' | 'compound' | 'parallel' | 'final';

export interface ParsedTransition {
  id: string;
  event: string;
  isOnDone: boolean;
  isShorthand: boolean;
  sourceStatePath: string;
  target?: string;
  targetRange?: SourceRange;
  transition?: string;
  transitionRange?: SourceRange;
  compensate?: string;
  compensateRange?: SourceRange;
  effects: string[];
  effectsRange?: SourceRange;
  description?: string;
  policy: PartialTransitionPolicy;
  policyRange?: SourceRange;
  onFailTargetRange?: SourceRange;
  effectivePolicy: NormalizedTransitionPolicy;
  policySources: PolicyFieldSources;
  keyRange: SourceRange;
  blockRange: SourceRange;
}

export interface ParsedStateNode {
  name: string;
  path: string;
  parentPath: string | null;
  explicitType?: StateNodeType;
  typeRange?: SourceRange;
  inferredType: StateNodeType;
  description?: string;
  initial?: string;
  initialKeyRange?: SourceRange;
  initialValueRange?: SourceRange;
  entry: string[];
  entryRange?: SourceRange;
  exit: string[];
  exitRange?: SourceRange;
  on: Record<string, ParsedTransition>;
  onKeyRange?: SourceRange;
  onDone?: ParsedTransition;
  states: Record<string, ParsedStateNode>;
  statesKeyRange?: SourceRange;
  keyRange: SourceRange;
  blockRange: SourceRange;
  isImplicitError: boolean;
  isCustomError: boolean;
}

export type ErrorStateMode = 'implicit' | 'custom';

export interface ParsedMachineHooks {
  onStart: string[];
  beforeTransition: string[];
  afterTransition: string[];
  onCompensate: string[];
  onComplete: string[];
  onTerminal: string[];
}

export interface ParsedMachine {
  dfsmVersion?: string;
  id?: string;
  idRange?: SourceRange;
  version: string;
  description?: string;
  rootType: 'compound' | 'parallel';
  explicitRootType?: 'compound' | 'parallel';
  rootTypeRange?: SourceRange;
  initial?: string;
  initialKeyRange?: SourceRange;
  initialValueRange?: SourceRange;
  registry?: {
    namespace?: string;
    strict: boolean;
  };
  defaults: PartialTransitionPolicy;
  defaultsRange?: SourceRange;
  defaultsOnFailTargetRange?: SourceRange;
  hooks: ParsedMachineHooks;
  effects: string[];
  maxEffectChainDepth?: number;
  states: Record<string, ParsedStateNode>;
  statesKeyRange?: SourceRange;
  allStatesByPath: Map<string, ParsedStateNode>;
  explicitStateCount: number;
  errorStateMode: ErrorStateMode;
  implicitErrorNode?: ParsedStateNode;
  rootRange: SourceRange;
}

export interface DfsmDocumentAnalysis {
  rawText: string;
  rawData: unknown;
  machine: ParsedMachine | null;
  diagnostics: DfsmDiagnostic[];
  errors: DfsmDiagnostic[];
  warnings: DfsmDiagnostic[];
  infos: DfsmDiagnostic[];
  isValid: boolean;
}
