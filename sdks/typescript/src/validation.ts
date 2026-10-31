import { ValidationError } from "./errors.js";

export interface ValidationIssue {
  path?: string;
  message: string;
}

export type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; issues: ValidationIssue[] };

export interface SchemaValidator<T> {
  validate(value: unknown): ValidationResult<T>;
}

/**
 * Duck-typed interface compatible with Zod v3/v4 schemas (`schema.safeParse(value)`).
 */
export interface SafeParseSchema<T> {
  safeParse(value: unknown):
    | { success: true; data: T }
    | {
        success: false;
        error: {
          issues?: Array<{ path?: Array<string | number>; message: string }>;
          message?: string;
        };
      };
}

export function isSafeParseSchema<T>(candidate: unknown): candidate is SafeParseSchema<T> {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    "safeParse" in candidate &&
    typeof (candidate as { safeParse?: unknown }).safeParse === "function"
  );
}

/**
 * Wraps any Zod schema (or `safeParse`-compatible schema) into a DFSM `SchemaValidator<T>`.
 */
export function zodValidator<T>(schema: SafeParseSchema<T>): SchemaValidator<T> {
  return {
    validate(value: unknown): ValidationResult<T> {
      const parsed = schema.safeParse(value);
      if (parsed.success) {
        return { success: true, data: parsed.data };
      }
      const issues: ValidationIssue[] =
        parsed.error.issues?.map((issue) => ({
          path: issue.path?.join(".") ?? "",
          message: issue.message,
        })) ?? [{ message: parsed.error.message ?? "Schema validation failed" }];
      return { success: false, issues };
    },
  };
}

/**
 * Creates a `SchemaValidator<T>` from a predicate or assertion function.
 */
export function customValidator<T>(
  fn: (value: unknown) => T | { valid: boolean; data?: T; errors?: string[] }
): SchemaValidator<T> {
  return {
    validate(value: unknown): ValidationResult<T> {
      try {
        const res = fn(value);
        if (
          typeof res === "object" &&
          res !== null &&
          "valid" in res &&
          typeof (res as { valid?: unknown }).valid === "boolean"
        ) {
          const structured = res as { valid: boolean; data?: T; errors?: string[] };
          if (structured.valid) {
            return { success: true, data: (structured.data ?? value) as T };
          }
          return {
            success: false,
            issues: (structured.errors ?? ["Validation failed"]).map((m) => ({ message: m })),
          };
        }
        return { success: true, data: res as T };
      } catch (err) {
        return {
          success: false,
          issues: [{ message: err instanceof Error ? err.message : String(err) }],
        };
      }
    },
  };
}

export type ValidatorInput<T> = SchemaValidator<T> | SafeParseSchema<T>;

export function toSchemaValidator<T>(
  validator?: ValidatorInput<T>
): SchemaValidator<T> | undefined {
  if (!validator) return undefined;
  if (isSafeParseSchema<T>(validator)) {
    return zodValidator(validator);
  }
  return validator;
}

export function enforceValidation<T>(
  target: "initialContext" | "input" | "context",
  value: unknown,
  validator?: SchemaValidator<T>
): T {
  if (!validator) {
    return value as T;
  }
  const res = validator.validate(value);
  if (res.success) {
    return res.data;
  }
  const details = res.issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message));
  throw new ValidationError(
    target,
    `Validation failed for ${target}: ${details.join("; ")}`,
    details
  );
}

