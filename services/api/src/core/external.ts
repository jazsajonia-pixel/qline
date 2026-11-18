import { AsyncLocalStorage } from "node:async_hooks";

/**
 * M1 (docs/17): honest outcomes for actions in connected apps.
 *
 * Every provider request goes through `api()` (oauth.ts) or `call()` (connectors.ts). While a tool runs inside
 * `trackExternal`, those helpers record each *mutating* request (anything but GET/HEAD) and how it ended:
 * - confirmed: the provider answered 2xx, so it happened;
 * - rejected: the provider answered with a definite refusal (4xx except 408, or Slack's `ok:false`), so it did not;
 * - otherwise (timeout, network error, 408, 5xx): the request left Qline and nobody knows.
 *
 * When the tool then throws, `classify` decides whether the action is a definite failure (nothing was sent, or every
 * send was refused) or an **unknown** outcome (something may have happened). Unknown actions are never retried
 * automatically; a person checks and resolves them.
 */
export interface ExternalTrace {
  sent: number;
  confirmed: number;
  rejected: number;
  /** M2: read requests (GET/HEAD) made, to measure what reusing a result saves. */
  reads?: number;
  /** Provider idempotency key for this action (sent where the provider supports it, e.g. Stripe). */
  idempotencyKey?: string;
}

const store = new AsyncLocalStorage<ExternalTrace>();

const MUTATING = (method: string | undefined) => {
  const m = (method ?? "GET").toUpperCase();
  return m !== "GET" && m !== "HEAD";
};

/** A 4xx (other than 408 Request Timeout) is a definite refusal: the provider did not perform the request. */
export function isDefiniteRefusal(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408;
}

/** Called by the provider helpers just before a request leaves Qline. Returns a function to record the answer. */
export function noteRequest(
  method: string | undefined,
): (status: number | null, okBody?: boolean) => void {
  const t = store.getStore();
  if (!t) return () => {};
  if (!MUTATING(method)) {
    t.reads = (t.reads ?? 0) + 1;
    return () => {};
  }
  t.sent += 1;
  return (status, okBody = true) => {
    if (status == null) return; // no answer: stays ambiguous
    if (status >= 200 && status < 300 && okBody) t.confirmed += 1;
    else if ((status >= 200 && status < 300) || isDefiniteRefusal(status))
      t.rejected += 1; // 200 + ok:false is a refusal
  };
}

/**
 * The provider idempotency key for the mutating request just noted. One key per request (`<action>:<n>`), because
 * providers like Stripe reject reusing a key with different parameters, and a tool may make several writes. The
 * sequence is deterministic, so a repeat of the same action sends the same keys in the same order.
 */
export function currentIdempotencyKey(): string | undefined {
  const t = store.getStore();
  return t?.idempotencyKey ? `${t.idempotencyKey}:${t.sent}` : undefined;
}

export type Outcome = "failed" | "unknown";

/** After a tool threw: was anything possibly done in a connected app? */
export function classify(t: ExternalTrace): Outcome {
  if (t.sent === 0) return "failed";
  if (t.confirmed === 0 && t.rejected === t.sent) return "failed";
  return "unknown";
}

export type Tracked<T> =
  | { ok: true; value: T; trace: ExternalTrace }
  | { ok: false; error: Error; outcome: Outcome; trace: ExternalTrace };

/**
 * Runs `fn` (a tool execution, usually with its own transaction) and reports what happened.
 * A throw after a provider confirmed a write (e.g. Qline's own commit failed) is `unknown`, not `failed`.
 */
export async function trackExternal<T>(
  fn: () => Promise<T>,
  opts: { idempotencyKey?: string } = {},
): Promise<Tracked<T>> {
  const trace: ExternalTrace = {
    sent: 0,
    confirmed: 0,
    rejected: 0,
    reads: 0,
    idempotencyKey: opts.idempotencyKey,
  };
  try {
    const value = await store.run(trace, fn);
    return { ok: true, value, trace };
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    return { ok: false, error, outcome: classify(trace), trace };
  }
}

/** Plain-language summary for an unknown outcome. Never includes provider bodies or tokens. */
export const UNKNOWN_SUMMARY =
  "Outcome unknown: the connected app may or may not have done this. It was not retried. Check it, then mark it done or not done.";

/** A short error message that is safe to store and show: secrets that providers sometimes echo are masked. */
export function safeError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(
      /\b(ya29\.[A-Za-z0-9._-]+|xox[abprs]-[A-Za-z0-9-]+|[sr]k_(live|test)_[A-Za-z0-9]+|gh[opsu]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|AIza[0-9A-Za-z_-]{20,})/g,
      "[redacted]",
    )
    .slice(0, 300);
}
