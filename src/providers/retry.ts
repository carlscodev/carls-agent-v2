export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
}

export class RetryableError extends Error {
  readonly status?: number;
  /** Server-requested delay before the next attempt, in ms. */
  readonly retryAfterMs?: number;
  constructor(message: string, status?: number, retryAfterMs?: number) {
    super(message);
    this.name = "RetryableError";
    if (status !== undefined) this.status = status;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

export class FatalError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "FatalError";
    if (status !== undefined) this.status = status;
  }
}

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

/**
 * Builds the right error for a non-2xx HTTP response: retryable for transient
 * statuses (429/5xx), fatal otherwise. Retrying a 401/402/404/422 never helps.
 */
export function httpError(status: number, message: string, retryAfterMs?: number): Error {
  return RETRYABLE_STATUS.has(status)
    ? new RetryableError(message, status, retryAfterMs)
    : new FatalError(message, status);
}

/**
 * Classifies an SDK/network error. 4xx validation errors are fatal (retrying
 * a malformed request never helps); 429/5xx and transport errors are retryable.
 */
export function classifyError(error: unknown): "retryable" | "fatal" {
  if (error instanceof FatalError) return "fatal";
  if (error instanceof RetryableError) return "retryable";

  const status = extractStatus(error);
  if (status !== undefined) {
    return RETRYABLE_STATUS.has(status) ? "retryable" : "fatal";
  }

  // No HTTP status: assume a transport hiccup (DNS, socket reset, timeout).
  const code = extractCode(error);
  if (
    code !== undefined &&
    ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE", "EAI_AGAIN", "ENOTFOUND"].includes(code)
  ) {
    return "retryable";
  }
  if (error instanceof Error && /timeout|socket hang up|network/i.test(error.message)) {
    return "retryable";
  }
  return "fatal";
}

function extractStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  if (typeof candidate.status === "number") return candidate.status;
  if (typeof candidate.statusCode === "number") return candidate.statusCode;
  if (candidate.response && typeof candidate.response.status === "number") {
    return candidate.response.status;
  }
  return undefined;
}

function extractCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { code?: unknown; cause?: { code?: unknown } };
  if (typeof candidate.code === "string") return candidate.code;
  if (candidate.cause && typeof candidate.cause.code === "string") return candidate.cause.code;
  return undefined;
}

function extractRetryAfterMs(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if (error instanceof RetryableError && error.retryAfterMs !== undefined) {
    return error.retryAfterMs;
  }
  const candidate = error as {
    retryAfterMs?: unknown;
    headers?: Record<string, string>;
    response?: { headers?: Record<string, string> };
  };
  if (typeof candidate.retryAfterMs === "number") return candidate.retryAfterMs;

  const headers = candidate.headers ?? candidate.response?.headers;
  const raw = headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (raw === undefined) return undefined;
  const seconds = Number.parseFloat(raw);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : undefined;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 15000;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const kind = classifyError(error);
      if (kind === "fatal" || attempt === maxAttempts) throw error;

      const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const jitter = Math.random() * exponential * 0.3;
      // A Retry-After header is authoritative: obey it instead of guessing.
      const requested = extractRetryAfterMs(error);
      const delay =
        requested !== undefined
          ? Math.min(requested, 60000)
          : Math.floor(exponential + jitter);
      options.onRetry?.(attempt, delay, error);
      await sleep(delay);
    }
  }
  throw lastError;
}
