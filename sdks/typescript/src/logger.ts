import type { StateValue } from "./types.js";

export interface BenchmarkLogRecord {
  timestamp: number;
  transactionId: string;
  machineId: string;
  actorId: string;
  event: string;
  transitionHandler?: string;
  fromState: StateValue;
  toState: StateValue;
  attempts: number;
  durationMs: number;
  outcome: "SUCCESS" | "COMPENSATED" | "FALLBACK" | "FAILED";
  error?: string;
}

export interface BenchmarkLogEngine {
  recordTransition(entry: BenchmarkLogRecord): void | Promise<void>;
  logRecovery?(actorId: string, message: string, metadata?: Record<string, unknown>): void | Promise<void>;
}

export class ConsoleBenchmarkLogger implements BenchmarkLogEngine {
  private readonly silent: boolean;

  constructor(options?: { silent?: boolean }) {
    this.silent = options?.silent ?? false;
  }

  recordTransition(entry: BenchmarkLogRecord): void {
    if (this.silent) return;
    console.info(
      JSON.stringify({
        level: entry.outcome === "SUCCESS" ? "info" : "warn",
        component: "dfsm.benchmark",
        ...entry,
      })
    );
  }

  logRecovery(actorId: string, message: string, metadata?: Record<string, unknown>): void {
    if (this.silent) return;
    console.warn(
      JSON.stringify({
        level: "warn",
        component: "dfsm.recovery",
        actorId,
        message,
        ...metadata,
      })
    );
  }
}

export class InMemoryBenchmarkLogger implements BenchmarkLogEngine {
  public readonly entries: BenchmarkLogRecord[] = [];
  public readonly recoveryLogs: Array<{
    actorId: string;
    message: string;
    metadata?: Record<string, unknown>;
  }> = [];

  recordTransition(entry: BenchmarkLogRecord): void {
    this.entries.push(entry);
  }

  logRecovery(actorId: string, message: string, metadata?: Record<string, unknown>): void {
    this.recoveryLogs.push({ actorId, message, metadata });
  }

  clear(): void {
    this.entries.length = 0;
    this.recoveryLogs.length = 0;
  }
}

