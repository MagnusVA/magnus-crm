/** Default timeout for Calendly API requests. */
export const CALENDLY_FETCH_TIMEOUT_MS = 30_000;

/** Short machine-like codes and titles only, never free text. */
const ERROR_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9 _.-]{0,47}$/;

/**
 * Reads the Calendly error code from a failed response: the OAuth `error`
 * field (`invalid_grant`) or the API `title` (`Permission Denied`). Returns
 * undefined for anything else, so response bodies never reach logs or
 * thrown messages.
 */
export async function readCalendlyErrorCode(
  response: Response,
): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) return undefined;
    const { error, title } = body as { error?: unknown; title?: unknown };
    const code = typeof error === "string" ? error : title;
    return typeof code === "string" && ERROR_CODE_PATTERN.test(code)
      ? code
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `Calendly <operation> failed: HTTP <status> (<code>)`. The ingest classifies
 * this shape as a Calendly integration error grouped by status.
 */
export function calendlyHttpErrorMessage(
  operation: string,
  status: number,
  code?: string,
): string {
  return `Calendly ${operation} failed: HTTP ${status}${code ? ` (${code})` : ""}`;
}

/** Builds the error for a failed Calendly response without its body. */
export async function calendlyHttpError(
  operation: string,
  response: Response,
): Promise<Error> {
  return new Error(
    calendlyHttpErrorMessage(
      operation,
      response.status,
      await readCalendlyErrorCode(response),
    ),
  );
}
