/**
 * Minimal OTLP/HTTP JSON log exporter for PostHog Logs.
 *
 * posthog-node has no logs API, and the OpenTelemetry SDK is a lot of
 * machinery for "POST a JSON batch", so server code sends logs through this.
 * Endpoint and payload: https://posthog.com/docs/logs/installation/other
 */

export type LogSeverity = "debug" | "info" | "warn" | "error";

export type LogAttributeValue = string | number | boolean | undefined | null;
export type LogAttributes = Record<string, LogAttributeValue>;

export type LogRecordInput = {
  /** Milliseconds since the epoch. */
  timestamp: number;
  severity: LogSeverity;
  body: string;
  attributes?: LogAttributes;
};

type OtlpValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number };

type OtlpKeyValue = { key: string; value: OtlpValue };

const SEVERITY: Record<LogSeverity, { text: string; number: number }> = {
  debug: { text: "DEBUG", number: 5 },
  info: { text: "INFO", number: 9 },
  warn: { text: "WARN", number: 13 },
  error: { text: "ERROR", number: 17 },
};

function toOtlpValue(value: Exclude<LogAttributeValue, undefined | null>): OtlpValue {
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  return { stringValue: value };
}

function toKeyValues(attributes: LogAttributes | undefined): OtlpKeyValue[] {
  if (!attributes) return [];
  const keyValues: OtlpKeyValue[] = [];
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === "") continue;
    keyValues.push({ key, value: toOtlpValue(value) });
  }
  return keyValues;
}

export function buildOtlpLogsPayload(
  resource: LogAttributes,
  records: LogRecordInput[],
) {
  return {
    resourceLogs: [
      {
        resource: { attributes: toKeyValues(resource) },
        scopeLogs: [
          {
            scope: { name: "magnus-crm" },
            logRecords: records.map((record) => ({
              timeUnixNano: `${Math.trunc(record.timestamp)}000000`,
              observedTimeUnixNano: `${Date.now()}000000`,
              severityText: SEVERITY[record.severity].text,
              severityNumber: SEVERITY[record.severity].number,
              body: { stringValue: record.body },
              attributes: toKeyValues(record.attributes),
            })),
          },
        ],
      },
    ],
  };
}

export type OtlpTarget = { host: string; projectToken: string };

const MAX_RECORDS_PER_REQUEST = 500;
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * `permanent` means retrying the same payload can't succeed (logs disabled,
 * bad token, quota), so callers shouldn't ask Convex to resend the batch.
 */
export class OtlpSendError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = "OtlpSendError";
  }
}

export async function sendOtlpLogs(
  target: OtlpTarget,
  resource: LogAttributes,
  records: LogRecordInput[],
): Promise<void> {
  const url = `${target.host.replace(/\/$/, "")}/i/v1/logs`;
  for (let start = 0; start < records.length; start += MAX_RECORDS_PER_REQUEST) {
    const chunk = records.slice(start, start + MAX_RECORDS_PER_REQUEST);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${target.projectToken}`,
        },
        body: JSON.stringify(buildOtlpLogsPayload(resource, chunk)),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new OtlpSendError(`PostHog logs request failed: ${String(error)}`, false);
    }
    if (!response.ok) {
      const retryable = response.status >= 500 || response.status === 429 || response.status === 408;
      throw new OtlpSendError(`PostHog logs ingest failed: HTTP ${response.status}`, !retryable);
    }
  }
}
