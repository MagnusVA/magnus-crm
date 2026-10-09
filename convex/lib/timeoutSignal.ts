/**
 * An `AbortSignal` that fires after `ms`, for `fetch` timeouts in either
 * runtime. Uses `AbortSignal.timeout` where it exists, falls back to an
 * `AbortController`, and returns `undefined` (no timeout) if neither exists,
 * so a missing API can never make the fetch itself throw.
 */
export function timeoutSignal(ms: number): AbortSignal | undefined {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  if (typeof AbortController !== "undefined") {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  }
  return undefined;
}
