/**
 * Turns a batch from the Convex webhook log stream into PostHog logs,
 * Error Tracking exceptions, and events. Pure functions, so the route
 * handler stays thin and this stays testable.
 *
 * Event schema: https://docs.convex.dev/production/integrations/log-streams
 */

import { decodeConsoleMessage, OBS_LOG_MARKER, parseObsLine } from "./convex-log-format";
import {
  classifyFailure,
  defaultFingerprint,
  isClientRunReason,
  normalizeErrorMessage,
  type ErrorClassification,
} from "./error-rules";
import type { LogAttributes, LogRecordInput, LogSeverity } from "./otlp-logs";
import { redactErrorText, redactPii } from "./redact";

type ConvexMeta = {
  deployment_name?: string;
  deployment_type?: string;
  project_name?: string;
  project_slug?: string;
};

type FunctionInfo = {
  type?: string;
  path?: string;
  cached?: boolean;
  request_id?: string;
  component_path?: string | null;
};

type BaseEvent = { topic: string; timestamp: number; convex?: ConvexMeta };

export type ConsoleEvent = BaseEvent & {
  topic: "console";
  function?: FunctionInfo;
  log_level?: string;
  message?: string;
  is_truncated?: boolean;
  system_code?: string | null;
};

export type FunctionExecutionEvent = BaseEvent & {
  topic: "function_execution";
  function?: FunctionInfo;
  execution_time_ms?: number;
  user_execution_time_ms?: number;
  status?: "success" | "failure";
  error_message?: string | null;
  mutation_queue_length?: number | null;
  mutation_retry_count?: number | null;
  occ_info?: {
    table_name?: string;
    document_id?: string;
    write_source?: string;
    retry_count?: number;
  } | null;
  scheduler_info?: { job_id?: string } | null;
  run_reason?: string;
  usage?: Record<string, number | null | undefined>;
};

export type LogStreamEvent =
  | ConsoleEvent
  | FunctionExecutionEvent
  | (BaseEvent & Record<string, unknown>);

export type RequestContext = {
  distinctId?: string;
  tenantId?: string;
  workosOrgId?: string;
  userId?: string;
  role?: string;
};

export type ExceptionCapture = {
  /** Deterministic, so a retried batch doesn't create duplicates. */
  uuid: string;
  distinctId: string;
  error: { name: string; message: string; stack?: string };
  properties: Record<string, unknown>;
};

export type EventCapture = {
  uuid: string;
  distinctId: string;
  event: string;
  timestamp: Date;
  properties: Record<string, unknown>;
};

export type TransformedBatch = {
  logs: LogRecordInput[];
  exceptions: ExceptionCapture[];
  events: EventCapture[];
};

export type TransformOptions = {
  /** Forward DEBUG console lines as logs. Context lines are never forwarded. */
  includeDebug?: boolean;
  /** Successful executions slower than this are logged as warnings. */
  slowFunctionMs?: Partial<Record<string, number>>;
  /** Scheduler lag above this is logged as a warning. */
  schedulerLagWarnSeconds?: number;
  /** Most distinct exceptions sent per batch; the rest are counted in a log line. */
  maxExceptions?: number;
};

const DEFAULT_SLOW_FUNCTION_MS: Record<string, number> = {
  query: 1_000,
  mutation: 1_000,
  action: 30_000,
  http_action: 10_000,
};

const DEFAULT_MAX_EXCEPTIONS = 50;

const SEVERITY_BY_CONSOLE_LEVEL: Record<string, LogSeverity> = {
  DEBUG: "debug",
  INFO: "info",
  LOG: "info",
  WARN: "warn",
  ERROR: "error",
};

function isEvent(value: unknown): value is LogStreamEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { topic?: unknown }).topic === "string" &&
    typeof (value as { timestamp?: unknown }).timestamp === "number"
  );
}

/** Accepts the stream's JSON array or JSONL body. Malformed entries are skipped. */
export function parseLogStreamBody(body: string): LogStreamEvent[] {
  const trimmed = body.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed.filter(isEvent) : [];
  }
  const events: LogStreamEvent[] = [];
  for (const line of trimmed.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isEvent(parsed)) events.push(parsed);
    } catch {
      // One bad line shouldn't lose the batch.
    }
  }
  return events;
}

/**
 * Splits Convex's `error_message` (`Uncaught Error: msg\n    at …`) into a
 * name, message, and stack that posthog-node can parse into frames.
 */
export function parseConvexErrorMessage(raw: string): {
  name: string;
  message: string;
  stack: string;
} {
  const lines = raw.split("\n");
  const firstFrame = lines.findIndex((line) => /^\s+at /.test(line));
  const head = (firstFrame === -1 ? lines : lines.slice(0, firstFrame))
    .join("\n")
    .replace(/^(Uncaught )+/, "")
    .trim();
  const headMatch = /^((?:[A-Z][A-Za-z]*)?(?:Error|Exception)): ([\s\S]*)$/.exec(head);
  const name = headMatch?.[1] ?? "Error";
  const message = (headMatch?.[2] ?? head).replace(/^(Uncaught )+/, "").trim() || "Unknown error";
  const frames = firstFrame === -1 ? [] : lines.slice(firstFrame);
  return { name, message, stack: [`${name}: ${message}`, ...frames].join("\n") };
}

/** A `ConvexError` message is its JSON data; the code comes from its top-level `code`. */
function extractConvexErrorCode(name: string, message: string): string | undefined {
  if (name !== "ConvexError") return undefined;
  try {
    const data: unknown = JSON.parse(message);
    if (typeof data === "object" && data !== null && typeof (data as { code?: unknown }).code === "string") {
      return (data as { code: string }).code;
    }
  } catch {
    // Not JSON; fall through.
  }
  return /^\{\s*"?code"?\s*:\s*"([\w.:-]+)"/.exec(message)?.[1];
}

/** 128-bit FNV-style hash formatted as a UUID, so retries reuse the same event id. */
export function stableUuid(seed: string): string {
  const parts: string[] = [];
  for (let round = 0; round < 4; round++) {
    let hash = 0x811c9dc5 ^ (round * 0x9e3779b1);
    for (let index = 0; index < seed.length; index++) {
      hash ^= seed.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    parts.push((hash >>> 0).toString(16).padStart(8, "0"));
  }
  const hex = parts.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Component functions (`aggregate`, `migrations`, `posthog`) get their component prefixed. */
function functionKey(info: FunctionInfo | undefined): string {
  const path = info?.path ?? "unknown";
  return info?.component_path ? `${info.component_path}/${path}` : path;
}

function convexAttributes(
  event: BaseEvent & { function?: FunctionInfo },
): LogAttributes {
  return {
    "convex.topic": event.topic,
    "convex.deployment.name": event.convex?.deployment_name,
    "convex.deployment.type": event.convex?.deployment_type,
    "convex.function.path": event.function ? functionKey(event.function) : undefined,
    "convex.function.type": event.function?.type,
    "convex.function.cached": event.function?.cached,
    "convex.request_id": event.function?.request_id,
  };
}

function contextAttributes(context: RequestContext | undefined): LogAttributes {
  if (!context) return {};
  return {
    // Key PostHog Logs reads to link a log line to a person.
    posthogDistinctId: context.distinctId,
    "tenant.id": context.tenantId,
    "tenant.workos_org_id": context.workosOrgId,
    "user.id": context.userId,
    "user.role": context.role,
  };
}

function flattenAttributes(
  value: Record<string, unknown>,
  prefix = "",
  out: LogAttributes = {},
  depth = 0,
): LogAttributes {
  for (const [key, entry] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (entry === null || entry === undefined) continue;
    if (typeof entry === "string") {
      out[name] = redactPii(entry);
    } else if (typeof entry === "number" || typeof entry === "boolean") {
      out[name] = entry;
    } else if (typeof entry === "object" && !Array.isArray(entry) && depth < 3) {
      flattenAttributes(entry as Record<string, unknown>, name, out, depth + 1);
    } else {
      out[name] = redactPii(JSON.stringify(entry));
    }
  }
  return out;
}

function exceptionProperties(
  base: BaseEvent & { function?: FunctionInfo },
  context: RequestContext | undefined,
): Record<string, unknown> {
  return {
    convex_function: base.function ? functionKey(base.function) : undefined,
    convex_function_type: base.function?.type,
    convex_request_id: base.function?.request_id,
    convex_deployment: base.convex?.deployment_name,
    convex_deployment_type: base.convex?.deployment_type,
    environment: base.convex?.deployment_type,
    tenant_id: context?.tenantId,
    user_id: context?.userId,
    user_role: context?.role,
    ...(context?.workosOrgId ? { $groups: { company: context.workosOrgId } } : {}),
    ...(context?.distinctId ? {} : { $process_person_profile: false }),
  };
}

function fallbackDistinctId(event: BaseEvent): string {
  return `convex:${event.convex?.deployment_name ?? "unknown"}`;
}

/** Dedupe key shared by `reportError` lines and failed executions in one request. */
function failureKey(requestId: string | undefined, message: string): string {
  return `${requestId ?? ""}|${normalizeErrorMessage(message)}`;
}

/**
 * Collects exceptions and collapses repeats of one fingerprint, so a failing
 * query that re-runs for every subscriber becomes one event with a count.
 */
class ExceptionCollector {
  private readonly byFingerprint = new Map<string, ExceptionCapture>();
  dropped = 0;

  constructor(private readonly max: number) {}

  add(capture: Omit<ExceptionCapture, "uuid">, seed: string) {
    const fingerprint = String(capture.properties.$exception_fingerprint);
    const existing = this.byFingerprint.get(fingerprint);
    if (existing) {
      existing.properties.occurrences_in_batch =
        Number(existing.properties.occurrences_in_batch ?? 1) + 1;
      return;
    }
    if (this.byFingerprint.size >= this.max) {
      this.dropped++;
      return;
    }
    this.byFingerprint.set(fingerprint, { ...capture, uuid: stableUuid(seed) });
  }

  values(): ExceptionCapture[] {
    return [...this.byFingerprint.values()];
  }
}

export function transformLogStreamBatch(
  events: LogStreamEvent[],
  options: TransformOptions = {},
): TransformedBatch {
  const slowMs = { ...DEFAULT_SLOW_FUNCTION_MS, ...options.slowFunctionMs };
  const lagWarnSeconds = options.schedulerLagWarnSeconds ?? 60;

  const logs: LogRecordInput[] = [];
  const eventsOut: EventCapture[] = [];
  const exceptions = new ExceptionCollector(options.maxExceptions ?? DEFAULT_MAX_EXCEPTIONS);

  const contextByRequest = new Map<string, RequestContext>();
  const rejectionCodeByRequest = new Map<string, string>();
  // A nested query or mutation runs with `run_reason: "action"` even when a
  // browser called the action, so classify by the request's outermost caller.
  const clientRequests = new Set<string>();
  const parsedConsole = new Map<ConsoleEvent, ReturnType<typeof parseObsLine>>();
  // A failure in a nested call fails every caller up the chain with the same
  // message, and code that reports an error with `reportError` may rethrow it.
  // Either way, report it once per request.
  const reportedFailures = new Set<string>();

  // First pass: who each request ran as, which requests a client started,
  // and which were rejected on purpose.
  for (const event of events) {
    if (event.topic === "function_execution") {
      const execution = event as FunctionExecutionEvent;
      const requestId = execution.function?.request_id;
      if (requestId && isClientRunReason(execution.run_reason)) clientRequests.add(requestId);
      continue;
    }
    if (event.topic !== "console") continue;
    const consoleEvent = event as ConsoleEvent;
    const parsed = parseObsLine(consoleEvent.message ?? "");
    parsedConsole.set(consoleEvent, parsed);
    const requestId = consoleEvent.function?.request_id;
    if (!parsed || !requestId) continue;
    if (parsed.event === "request.context") {
      const { distinctId, tenantId, workosOrgId, userId, role } = parsed.attributes;
      contextByRequest.set(requestId, {
        ...contextByRequest.get(requestId),
        ...(typeof distinctId === "string" ? { distinctId } : {}),
        ...(typeof tenantId === "string" ? { tenantId } : {}),
        ...(typeof workosOrgId === "string" ? { workosOrgId } : {}),
        ...(typeof userId === "string" ? { userId } : {}),
        ...(typeof role === "string" ? { role } : {}),
      });
    } else if (parsed.event === "request.rejected" && typeof parsed.attributes.code === "string") {
      rejectionCodeByRequest.set(requestId, parsed.attributes.code);
    } else if (parsed.attributes.obs_kind === "exception") {
      const error = parsed.attributes.error as { message?: unknown } | undefined;
      if (typeof error?.message === "string") {
        reportedFailures.add(failureKey(requestId, error.message));
      }
    }
  }

  for (const event of events) {
    const timestamp = event.timestamp;
    switch (event.topic) {
      case "verification":
        break;

      case "console": {
        const consoleEvent = event as ConsoleEvent;
        const parsed = parsedConsole.get(consoleEvent) ?? null;
        const requestId = consoleEvent.function?.request_id;
        const context = requestId ? contextByRequest.get(requestId) : undefined;
        const severity = SEVERITY_BY_CONSOLE_LEVEL[consoleEvent.log_level ?? "LOG"] ?? "info";

        if (parsed?.attributes.obs_kind === "context") break;
        if (severity === "debug" && !options.includeDebug) break;

        const decoded = parsed ? null : decodeConsoleMessage(consoleEvent.message ?? "");
        const attributes: LogAttributes = {
          ...convexAttributes(consoleEvent),
          ...contextAttributes(context),
          "convex.log.truncated": consoleEvent.is_truncated || undefined,
          "convex.system_code": consoleEvent.system_code ?? undefined,
        };
        if (parsed) {
          attributes["event.name"] = parsed.event;
          Object.assign(attributes, flattenAttributes(parsed.attributes, "attr"));
        }
        logs.push({
          timestamp,
          severity,
          body: parsed ? parsed.event : redactPii(decoded ?? ""),
          attributes,
        });

        if (parsed?.attributes.obs_kind === "exception") {
          const error = (parsed.attributes.error ?? {}) as {
            name?: string;
            message?: string;
            stack?: string;
            code?: string;
          };
          const errorName = error.name ?? "Error";
          const errorMessage = error.message ?? parsed.event;
          const severityLevel = parsed.attributes.severity === "warning" ? "warning" : "error";
          const fingerprint =
            typeof parsed.attributes.fingerprint === "string"
              ? parsed.attributes.fingerprint
              : `convex-handled:${parsed.event}:${errorName}:${normalizeErrorMessage(errorMessage)}`;
          const extra = { ...parsed.attributes };
          delete extra.error;
          delete extra.obs_kind;
          delete extra.severity;
          delete extra.fingerprint;
          exceptions.add(
            {
              distinctId: context?.distinctId ?? fallbackDistinctId(consoleEvent),
              error: {
                name: errorName,
                message: redactErrorText(errorMessage),
                stack: error.stack ? redactErrorText(error.stack) : undefined,
              },
              properties: {
                ...exceptionProperties(consoleEvent, context),
                ...flattenAttributes(extra),
                $exception_fingerprint: fingerprint,
                $exception_level: severityLevel,
                error_kind: parsed.attributes.integration ? "integration" : "bug",
                error_event: parsed.event,
                error_code: error.code,
                convex_handled: true,
              },
            },
            `${requestId ?? timestamp}|${fingerprint}`,
          );
        } else if (
          !parsed &&
          consoleEvent.is_truncated &&
          decoded?.startsWith(OBS_LOG_MARKER) &&
          decoded.includes('"obs_kind":"exception"')
        ) {
          // A `reportError` line too long to parse still has to reach Error Tracking.
          const eventName = decoded.slice(OBS_LOG_MARKER.length + 1).split(" ", 1)[0] || "unknown";
          exceptions.add(
            {
              distinctId: context?.distinctId ?? fallbackDistinctId(consoleEvent),
              error: { name: "TruncatedReport", message: `Truncated reportError line for ${eventName}` },
              properties: {
                ...exceptionProperties(consoleEvent, context),
                $exception_fingerprint: `convex-handled:${eventName}:truncated`,
                $exception_level: "error",
                error_kind: "bug",
                error_event: eventName,
                convex_handled: true,
              },
            },
            `${requestId ?? timestamp}|truncated|${eventName}`,
          );
        }
        break;
      }

      case "function_execution": {
        const execution = event as FunctionExecutionEvent;
        const requestId = execution.function?.request_id;
        const context = requestId ? contextByRequest.get(requestId) : undefined;
        const functionPath = functionKey(execution.function);
        const functionType = execution.function?.type ?? "unknown";
        const attributes: LogAttributes = {
          ...convexAttributes(execution),
          ...contextAttributes(context),
          "convex.execution_time_ms": execution.execution_time_ms,
          "convex.user_execution_time_ms": execution.user_execution_time_ms,
          "convex.run_reason": execution.run_reason,
          "convex.scheduler.job_id": execution.scheduler_info?.job_id,
          "convex.mutation.retry_count": execution.mutation_retry_count ?? undefined,
          "convex.mutation.queue_length": execution.mutation_queue_length ?? undefined,
          "convex.occ.table": execution.occ_info?.table_name,
          "convex.occ.write_source": execution.occ_info?.write_source,
          "convex.occ.retry_count": execution.occ_info?.retry_count,
          ...flattenAttributes(execution.usage ?? {}, "convex.usage"),
        };

        if (execution.status === "failure") {
          const rawError = parseConvexErrorMessage(execution.error_message ?? "Unknown error");
          // Read the code before redaction strips the quoted JSON it lives in.
          const code =
            extractConvexErrorCode(rawError.name, rawError.message) ??
            (requestId ? rejectionCodeByRequest.get(requestId) : undefined);
          const parsedError = {
            name: rawError.name,
            message: redactErrorText(rawError.message),
            stack: redactErrorText(rawError.stack),
          };

          // Convex retries write conflicts; a failed attempt is a contention
          // signal, not a bug. Alert on the log rate instead.
          if (execution.occ_info) {
            Object.assign(attributes, { "error.kind": "platform", "error.code": "convex.write_conflict" });
            logs.push({
              timestamp,
              severity: "warn",
              body: `convex.function.write_conflict ${functionPath}`,
              attributes,
            });
            break;
          }

          const classification: ErrorClassification = classifyFailure({
            functionPath,
            errorName: parsedError.name,
            errorMessage: parsedError.message,
            fromClient: requestId
              ? clientRequests.has(requestId)
              : isClientRunReason(execution.run_reason),
            code,
          });

          Object.assign(attributes, {
            "error.kind": classification.kind,
            "error.rule": classification.rule,
            "error.code": classification.code,
            "error.name": parsedError.name,
            "error.message": parsedError.message,
          });
          logs.push({
            timestamp,
            severity: classification.kind === "expected" ? "warn" : "error",
            body:
              classification.kind === "expected"
                ? `convex.function.rejected ${functionPath}`
                : `convex.function.failed ${functionPath}`,
            attributes,
          });

          const dedupeKey = failureKey(requestId ?? String(timestamp), rawError.message);
          if (reportedFailures.has(dedupeKey)) break;
          reportedFailures.add(dedupeKey);

          const distinctId = context?.distinctId ?? fallbackDistinctId(execution);
          const properties = {
            ...exceptionProperties(execution, context),
            convex_run_reason: execution.run_reason,
            convex_execution_time_ms: execution.execution_time_ms,
            convex_scheduler_job_id: execution.scheduler_info?.job_id,
            error_kind: classification.kind,
            error_rule: classification.rule,
            error_code: classification.code,
            integration: classification.integration,
          };

          if (classification.kind === "expected") {
            eventsOut.push({
              uuid: stableUuid(`${dedupeKey}|rejected`),
              distinctId,
              event: "convex_request_rejected",
              timestamp: new Date(timestamp),
              // The normalized message: user input stays out of event properties.
              properties: { ...properties, error_message: normalizeErrorMessage(rawError.message) },
            });
          } else {
            const fingerprint =
              classification.fingerprint ??
              defaultFingerprint({
                functionPath,
                errorName: parsedError.name,
                errorMessage: rawError.message,
              });
            exceptions.add(
              {
                distinctId,
                error: parsedError,
                properties: {
                  ...properties,
                  $exception_fingerprint: fingerprint,
                  $exception_level: "error",
                  convex_handled: false,
                },
              },
              `${dedupeKey}|${fingerprint}`,
            );
          }
          break;
        }

        const threshold = slowMs[functionType];
        const isSlow =
          threshold !== undefined && (execution.execution_time_ms ?? 0) > threshold;
        const retriedConflict = (execution.mutation_retry_count ?? 0) > 0;
        if (isSlow || retriedConflict) {
          logs.push({
            timestamp,
            severity: "warn",
            body: isSlow
              ? `convex.function.slow ${functionPath}`
              : `convex.function.write_conflict_retried ${functionPath}`,
            attributes,
          });
        }
        break;
      }

      case "scheduler_stats": {
        const { convex: _convex, timestamp: _timestamp, topic: _topic, ...stats } =
          event as Record<string, unknown>;
        const lag = Number(stats.lag_seconds ?? 0);
        logs.push({
          timestamp,
          severity: lag > lagWarnSeconds ? "warn" : "info",
          body: "convex.scheduler.stats",
          attributes: { ...convexAttributes(event), ...flattenAttributes(stats) },
        });
        break;
      }

      default: {
        // audit_log, concurrency_stats, storage usage, and future topics.
        const { convex: _convex, timestamp: _timestamp, ...rest } = event as Record<string, unknown>;
        logs.push({
          timestamp,
          severity: "info",
          body: `convex.${event.topic}`,
          attributes: { ...convexAttributes(event), ...flattenAttributes(rest) },
        });
      }
    }
  }

  if (exceptions.dropped > 0) {
    logs.push({
      timestamp: Date.now(),
      severity: "warn",
      body: "observability.exceptions_capped",
      attributes: { "observability.dropped_exceptions": exceptions.dropped },
    });
  }

  return { logs, exceptions: exceptions.values(), events: eventsOut };
}
