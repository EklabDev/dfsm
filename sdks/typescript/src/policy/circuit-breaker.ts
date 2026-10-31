import { CircuitOpenError, ValidationError } from "../errors.js";
import type { CircuitStatus, Clock, NormalizedCircuitBreakerPolicy } from "../types.js";

export class CircuitBreakerInstance {
  public readonly key: string;
  private policy: NormalizedCircuitBreakerPolicy;
  private readonly clock: Clock;

  private status: CircuitStatus = "CLOSED";
  private openedAt = 0;
  private outcomesWindow: boolean[] = []; // true = success, false = failure
  private halfOpenInFlight = 0;
  private halfOpenSuccesses = 0;

  constructor(policy: NormalizedCircuitBreakerPolicy, clock: Clock) {
    this.key = policy.key;
    this.policy = policy;
    this.clock = clock;
  }

  updatePolicy(policy: NormalizedCircuitBreakerPolicy): void {
    this.policy = policy;
  }

  getStatus(): CircuitStatus {
    this.evaluateTimerTransition();
    return this.status;
  }

  reset(): void {
    this.status = "CLOSED";
    this.openedAt = 0;
    this.outcomesWindow = [];
    this.halfOpenInFlight = 0;
    this.halfOpenSuccesses = 0;
  }

  private evaluateTimerTransition(): void {
    if (this.status === "OPEN") {
      const elapsed = this.clock.now() - this.openedAt;
      if (elapsed >= this.policy.openDurationMs) {
        this.status = "HALF_OPEN";
        this.halfOpenInFlight = 0;
        this.halfOpenSuccesses = 0;
      }
    }
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.policy.enabled) {
      return fn();
    }

    this.evaluateTimerTransition();

    if (this.status === "OPEN") {
      const remaining = this.policy.openDurationMs - (this.clock.now() - this.openedAt);
      throw new CircuitOpenError(this.key, remaining);
    }

    if (this.status === "HALF_OPEN") {
      if (this.halfOpenInFlight >= this.policy.halfOpenMaxCalls) {
        throw new CircuitOpenError(this.key, this.policy.openDurationMs);
      }
      this.halfOpenInFlight++;
    }

    try {
      const res = await fn();
      this.onSuccess();
      return res;
    } catch (err) {
      if (!(err instanceof ValidationError)) {
        this.onFailure();
      } else if (this.status === "HALF_OPEN") {
        this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
      }
      throw err;
    }
  }

  private onSuccess(): void {
    if (this.status === "HALF_OPEN") {
      this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.policy.halfOpenMaxCalls) {
        this.reset();
      }
      return;
    }

    this.pushOutcome(true);
  }

  private onFailure(): void {
    if (this.status === "HALF_OPEN") {
      this.tripOpen();
      return;
    }

    this.pushOutcome(false);
    const failures = this.outcomesWindow.filter((ok) => !ok).length;
    if (failures >= this.policy.failureThreshold) {
      this.tripOpen();
    }
  }

  private pushOutcome(ok: boolean): void {
    this.outcomesWindow.push(ok);
    while (this.outcomesWindow.length > this.policy.slidingWindowSize) {
      this.outcomesWindow.shift();
    }
  }

  private tripOpen(): void {
    this.status = "OPEN";
    this.openedAt = this.clock.now();
    this.halfOpenInFlight = 0;
    this.halfOpenSuccesses = 0;
    this.outcomesWindow = [];
  }
}

export class CircuitBreakerManager {
  private readonly breakers = new Map<string, CircuitBreakerInstance>();
  private readonly clock: Clock;

  constructor(clock: Clock) {
    this.clock = clock;
  }

  getOrCreate(policy: NormalizedCircuitBreakerPolicy): CircuitBreakerInstance {
    let instance = this.breakers.get(policy.key);
    if (!instance) {
      instance = new CircuitBreakerInstance(policy, this.clock);
      this.breakers.set(policy.key, instance);
    } else {
      instance.updatePolicy(policy);
    }
    return instance;
  }

  getStatus(key: string): CircuitStatus {
    return this.breakers.get(key)?.getStatus() ?? "CLOSED";
  }

  reset(key?: string): void {
    if (key) {
      this.breakers.get(key)?.reset();
      return;
    }
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }
}

