export const ZCODE_E2E_FS_FAULTS_ENV = "ZCODE_E2E_FS_FAULTS";
export const ZCODE_E2E_FS_FAULTS_ALLOW_ENV = "ZCODE_E2E_FS_FAULTS_ALLOW";

export type StorageFsFaultOperation =
  | "appendFile"
  | "any"
  | "mkdir"
  | "rename"
  | "rm"
  | "sqliteOpen"
  | "sqliteRun"
  | "writeFile";

export interface StorageFsFaultRule {
  id: string;
  code: string;
  operations?: readonly StorageFsFaultOperation[];
  pathIncludes?: string;
  pathEndsWith?: string;
  pathRegex?: string;
  maxMatches?: number;
  message?: string;
}

export interface StorageFsFaultInput {
  operation: StorageFsFaultOperation;
  path: string;
}

interface NormalizedStorageFsFaultRule {
  code: string;
  id: string;
  maxMatches: number;
  message?: string;
  operations: ReadonlySet<StorageFsFaultOperation>;
  pathEndsWith?: string;
  pathIncludes?: string;
  pathRegex?: RegExp;
  matchedCount: number;
}

export interface InjectedStorageFsFaultError extends NodeJS.ErrnoException {
  zcodeFsFaultId: string;
}

const SUPPORTED_OPERATIONS = new Set<StorageFsFaultOperation>([
  "appendFile",
  "any",
  "mkdir",
  "rename",
  "rm",
  "sqliteOpen",
  "sqliteRun",
  "writeFile",
]);

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function requireNonEmptyString(value: unknown, field: string, index: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid fs fault rule at index ${index}: ${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string, index: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Invalid fs fault rule at index ${index}: ${field} must be a string`);
  }
  return value;
}

function normalizeOperations(value: unknown, index: number): readonly StorageFsFaultOperation[] {
  if (value === undefined) return ["any"];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Invalid fs fault rule at index ${index}: operations must be a non-empty array`);
  }
  return value.map((operation) => {
    if (typeof operation !== "string" || !SUPPORTED_OPERATIONS.has(operation as StorageFsFaultOperation)) {
      throw new Error(
        `Invalid fs fault rule at index ${index}: unsupported operation ${String(operation)}`,
      );
    }
    return operation as StorageFsFaultOperation;
  });
}

function normalizeRule(rule: StorageFsFaultRule, index: number): NormalizedStorageFsFaultRule {
  const record = rule as unknown as Record<string, unknown>;
  const maxMatches = record.maxMatches === undefined ? 1 : record.maxMatches;
  if (typeof maxMatches !== "number" || !Number.isInteger(maxMatches) || maxMatches < 0) {
    throw new Error(`Invalid fs fault rule at index ${index}: maxMatches must be a non-negative integer`);
  }
  const pathRegexRaw = optionalString(record.pathRegex, "pathRegex", index);

  return {
    code: requireNonEmptyString(record.code, "code", index),
    id: requireNonEmptyString(record.id, "id", index),
    matchedCount: 0,
    maxMatches,
    message: optionalString(record.message, "message", index),
    operations: new Set(normalizeOperations(record.operations, index)),
    pathEndsWith: optionalString(record.pathEndsWith, "pathEndsWith", index),
    pathIncludes: optionalString(record.pathIncludes, "pathIncludes", index),
    pathRegex: pathRegexRaw === undefined ? undefined : new RegExp(pathRegexRaw),
  };
}

function parseRules(rawValue: string): StorageFsFaultRule[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch (error) {
    throw new Error(
      `Invalid ${ZCODE_E2E_FS_FAULTS_ENV}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Invalid ${ZCODE_E2E_FS_FAULTS_ENV}: expected a JSON array`);
  }
  return parsed.map((rule, index) => {
    if (typeof rule !== "object" || rule === null || Array.isArray(rule)) {
      throw new Error(`Invalid fs fault rule at index ${index}: rule must be an object`);
    }
    return rule as StorageFsFaultRule;
  });
}

function operationMatches(rule: NormalizedStorageFsFaultRule, operation: StorageFsFaultOperation): boolean {
  return rule.operations.has("any") || rule.operations.has(operation);
}

function pathMatches(rule: NormalizedStorageFsFaultRule, path: string): boolean {
  const normalizedPath = normalizePath(path);
  const includes = rule.pathIncludes === undefined || normalizedPath.includes(normalizePath(rule.pathIncludes));
  const endsWith = rule.pathEndsWith === undefined || normalizedPath.endsWith(normalizePath(rule.pathEndsWith));
  const regex = rule.pathRegex === undefined || rule.pathRegex.test(normalizedPath);
  return includes && endsWith && regex;
}

function createInjectedError(input: {
  code: string;
  id: string;
  message?: string;
  operation: StorageFsFaultOperation;
  path: string;
}): InjectedStorageFsFaultError {
  const error = new Error(
    input.message ?? `Injected fs fault ${input.code} for ${input.operation}: ${input.path}`,
  ) as InjectedStorageFsFaultError;
  error.code = input.code;
  error.path = input.path;
  error.syscall = input.operation;
  error.zcodeFsFaultId = input.id;
  return error;
}

export interface StorageFsFaultInjector {
  maybeThrow(input: StorageFsFaultInput): void;
  reset(): void;
}

export function createStorageFsFaultInjector(
  rules: readonly StorageFsFaultRule[] = [],
): StorageFsFaultInjector {
  const normalizedRules = rules.map((rule, index) => normalizeRule(rule, index));
  return {
    maybeThrow(input: StorageFsFaultInput): void {
      for (const rule of normalizedRules) {
        if (
          (rule.maxMatches > 0 && rule.matchedCount >= rule.maxMatches) ||
          !operationMatches(rule, input.operation) ||
          !pathMatches(rule, input.path)
        ) {
          continue;
        }
        rule.matchedCount += 1;
        throw createInjectedError({
          code: rule.code,
          id: rule.id,
          message: rule.message,
          operation: input.operation,
          path: input.path,
        });
      }
    },
    reset(): void {
      for (const rule of normalizedRules) {
        rule.matchedCount = 0;
      }
    },
  };
}

let envInjector: StorageFsFaultInjector | null = null;
let injectedForTests: StorageFsFaultInjector | null = null;

function createStorageFsFaultInjectorFromEnv(
  env: Record<string, string | undefined> = process.env,
): StorageFsFaultInjector {
  const rawValue = env[ZCODE_E2E_FS_FAULTS_ENV]?.trim();
  if (!rawValue || (env.ZCODE_ENV !== "test" && env[ZCODE_E2E_FS_FAULTS_ALLOW_ENV] !== "1")) {
    return createStorageFsFaultInjector();
  }
  return createStorageFsFaultInjector(parseRules(rawValue));
}

function getStorageFsFaultInjector(): StorageFsFaultInjector {
  if (injectedForTests) return injectedForTests;
  envInjector ??= createStorageFsFaultInjectorFromEnv();
  return envInjector;
}

export function maybeThrowStorageFsFault(input: StorageFsFaultInput): void {
  getStorageFsFaultInjector().maybeThrow(input);
}

export function setStorageFsFaultInjectorForTests(injector: StorageFsFaultInjector | null): void {
  injectedForTests = injector;
}

export function resetStorageFsFaultInjectorForTests(): void {
  envInjector = null;
  injectedForTests = null;
}
