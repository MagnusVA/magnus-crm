import { afterEach, describe, expect, test, vi } from "vitest";
import {
  log,
  logRequestContext,
  reportError,
} from "../../convex/lib/observability/log";
import { convexExceptionBeforeSend } from "./client-exceptions";
import { decodeConsoleMessage, parseObsLine } from "./convex-log-format";
import {
  parseConvexErrorMessage,
  parseLogStreamBody,
  transformLogStreamBatch,
  type LogStreamEvent,
} from "./convex-log-stream";
import { classifyFailure, normalizeErrorMessage } from "./error-rules";
import { buildOtlpLogsPayload } from "./otlp-logs";
import { readPostHogCookie } from "./posthog-cookie";

/** What the log stream does to a console argument (object-inspect). */
function inspectString(value: string): string {
  return `'${value.replace(/(['\\])/g, "\\$1")}'`;
}

/** Runs a Convex logger call and returns the line exactly as the log stream would carry it. */
function captureConsoleLine(write: () => void): { level: string; message: string } {
  const lines: Array<{ level: string; message: string }> = [];
  const levels = { debug: "DEBUG", info: "INFO", warn: "WARN", error: "ERROR" } as const;
  const spies = (Object.keys(levels) as Array<keyof typeof levels>).map((method) =>
    vi.spyOn(console, method).mockImplementation((line: unknown) => {
      lines.push({ level: levels[method], message: inspectString(String(line)) });
    }),
  );
  write();
  for (const spy of spies) spy.mockRestore();
  expect(lines).toHaveLength(1);
  return lines[0];
}

const convex = { deployment_name: "happy-otter-123", deployment_type: "prod" };

function consoleEvent(
  requestId: string,
  line: { level: string; message: string },
  path = "closer/payments:logPayment",
): LogStreamEvent {
  return {
    topic: "console",
    timestamp: 1_760_000_000_000,
    convex,
    function: { type: "mutation", path, request_id: requestId },
    log_level: line.level,
    message: line.message,
  };
}

function failure(
  requestId: string,
  errorMessage: string,
  overrides: Record<string, unknown> = {},
): LogStreamEvent {
  return {
    topic: "function_execution",
    timestamp: 1_760_000_000_500,
    convex,
    function: { type: "mutation", path: "closer/payments:logPayment", request_id: requestId },
    execution_time_ms: 42,
    status: "failure",
    error_message: errorMessage,
    run_reason: "webSocket",
    ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("structured console lines", () => {
  test("round-trip from the Convex logger through object-inspect", () => {
    const line = captureConsoleLine(() =>
      log.info("pipeline.event.processed", { reason: "it's done", path: "a\\b", count: 2 }),
    );
    expect(line.level).toBe("INFO");
    expect(parseObsLine(line.message)).toEqual({
      event: "pipeline.event.processed",
      attributes: { reason: "it's done", path: "a\\b", count: 2 },
    });
  });

  test("decodes escaped control characters", () => {
    expect(decodeConsoleMessage("'line one\\nline two'")).toBe("line one\nline two");
  });

  test("ignores ordinary console output", () => {
    expect(parseObsLine(inspectString("[Pipeline] processing event"))).toBeNull();
    expect(decodeConsoleMessage(inspectString("it's"))).toBe("it's");
  });

  test("truncated lines fall back to unparsed", () => {
    expect(parseObsLine(`'[obs] pipeline.event {"a":"b`)).toBeNull();
  });
});

describe("parseConvexErrorMessage", () => {
  test("splits name, message, and stack frames", () => {
    const parsed = parseConvexErrorMessage(
      "Uncaught Error: Opportunity not found\n    at handler (../convex/closer/payments.ts:45:10)\n",
    );
    expect(parsed.name).toBe("Error");
    expect(parsed.message).toBe("Opportunity not found");
    expect(parsed.stack).toContain("at handler (../convex/closer/payments.ts:45:10)");
  });

  test("handles messages without a stack", () => {
    expect(parseConvexErrorMessage("Server Error")).toMatchObject({
      name: "Error",
      message: "Server Error",
    });
  });
});

describe("classifyFailure", () => {
  const base = { functionPath: "closer/payments:logPayment", errorName: "Error" };
  const fromClient = (errorMessage: string) => classifyFailure({ ...base, errorMessage, fromClient: true });
  const fromBackground = (errorMessage: string) => classifyFailure({ ...base, errorMessage, fromClient: false });

  test("coded and ConvexError failures are expected", () => {
    expect(classifyFailure({ ...base, errorMessage: "x", fromClient: false, code: "auth.not_authenticated" }).kind).toBe("expected");
    expect(classifyFailure({ ...base, errorName: "ConvexError", errorMessage: "x", fromClient: false }).kind).toBe("expected");
  });

  test("legacy rejections are expected only when a client made the call", () => {
    expect(fromClient("Insufficient permissions").kind).toBe("expected");
    expect(fromBackground("Insufficient permissions").kind).toBe("bug");
    expect(fromClient("Opportunity not found").kind).toBe("expected");
    expect(fromBackground("Opportunity not found").kind).toBe("bug");
    expect(fromClient("Payment amount must be positive").kind).toBe("expected");
  });

  test("bugs that look like validation or a missing record stay bugs", () => {
    for (const message of [
      "LINK_PORTAL_SESSION_SECRET must be at least 32 characters.",
      "Winning opportunity not found",
      "Sold program for this opportunity was not found.",
      "Artifact reservation not found.",
      "Calendly connection not found.",
      "Invalid business date weekday",
      "Only void aggregate corrections are supported",
      "Tenant not found",
    ]) {
      expect(fromClient(message).kind, message).toBe("bug");
    }
  });

  test("limits and timeouts are platform errors", () => {
    expect(fromClient("Too many reads in a single function execution").kind).toBe("platform");
    expect(fromBackground("Function execution timed out (maximum duration: 600s)").kind).toBe("platform");
  });

  test("vendor HTTP failures are integration errors grouped by status, before expected rules", () => {
    expect(fromBackground("Calendly API error: status 502")).toMatchObject({
      kind: "integration",
      integration: "calendly",
      code: "calendly.http_502",
    });
    expect(fromBackground("Calendly event type sync failed: 400 must be a valid URI")).toMatchObject({
      kind: "integration",
      code: "calendly.http_400",
    });
    expect(fromClient("Unable to inspect Calendly webhook subscription: HTTP 404 Not Found").kind).toBe("integration");
  });

  test("bugs that mention status or token aren't integration errors", () => {
    expect(
      classifyFailure({
        functionPath: "slack/notify:postConfirmation",
        errorName: "TypeError",
        errorMessage: "Cannot read properties of undefined (reading 'token')",
        fromClient: false,
      }).kind,
    ).toBe("bug");
  });

  test("normalization strips ids, ULIDs, hex, and double-quoted values", () => {
    expect(normalizeErrorMessage('Meeting jd7abcdefghijklmnopqrstuvwxyz012 has 3 "rows"')).toBe(
      "Meeting <id> has <n> <value>",
    );
    expect(normalizeErrorMessage("No membership found for user user_01J8ZK3QW4E5R6T7Y8U9I0OPAS")).toBe(
      "No membership found for user <ulid>",
    );
    expect(normalizeErrorMessage("Upstream ray 8f3a9c0d1e2b4a5f failed")).toBe("Upstream ray <hex> failed");
    expect(normalizeErrorMessage("Couldn't sync, won't retry")).toBe("Couldn't sync, won't retry");
  });
});

describe("transformLogStreamBatch", () => {
  test("attributes a failure to the request's user and tenant", () => {
    const context = captureConsoleLine(() =>
      logRequestContext({ distinctId: "user_123", tenantId: "t1", workosOrgId: "org_1", role: "closer" }),
    );
    const batch = transformLogStreamBatch([
      consoleEvent("req1", context),
      failure("req1", "Uncaught TypeError: x is undefined\n    at handler (../convex/closer/payments.ts:1:1)"),
    ]);

    expect(batch.exceptions).toHaveLength(1);
    const [exception] = batch.exceptions;
    expect(exception.distinctId).toBe("user_123");
    expect(exception.error.name).toBe("TypeError");
    expect(exception.properties).toMatchObject({
      convex_function: "closer/payments:logPayment",
      convex_request_id: "req1",
      tenant_id: "t1",
      $groups: { company: "org_1" },
      error_kind: "bug",
      convex_handled: false,
    });
    expect(exception.properties.$exception_fingerprint).toBe(
      "convex:closer/payments:logPayment:TypeError:x is undefined",
    );
    // Context lines feed attribution but aren't forwarded as logs.
    expect(batch.logs.map((entry) => entry.body)).toEqual([
      "convex.function.failed closer/payments:logPayment",
    ]);
    expect(batch.logs[0].attributes?.posthogDistinctId).toBe("user_123");
  });

  test("an expected rejection becomes an event, not an exception", () => {
    const rejected = captureConsoleLine(() => {
      // rejectRequest logs this line before throwing.
      log.warn("request.rejected", { code: "auth.insufficient_permissions" });
    });
    const batch = transformLogStreamBatch([
      consoleEvent("req2", rejected),
      failure("req2", "Uncaught Error: Insufficient permissions"),
    ]);
    expect(batch.exceptions).toHaveLength(0);
    expect(batch.events).toEqual([
      expect.objectContaining({
        event: "convex_request_rejected",
        distinctId: "convex:happy-otter-123",
        properties: expect.objectContaining({ error_code: "auth.insufficient_permissions" }),
      }),
    ]);
    expect(batch.logs.find((entry) => entry.body.startsWith("convex.function.rejected"))?.severity).toBe("warn");
  });

  test("a handled error reported with reportError becomes an exception", () => {
    const line = captureConsoleLine(() =>
      reportError("slack.notify.failed", new Error("channel_not_found"), {
        severity: "warning",
        integration: "slack",
        fingerprint: "slack.notify.failed:channel_not_found",
        tenantId: "t1",
      }),
    );
    const batch = transformLogStreamBatch([consoleEvent("req3", line, "slack/notify:postConfirmation")]);
    expect(batch.exceptions).toHaveLength(1);
    expect(batch.exceptions[0].error.message).toBe("channel_not_found");
    expect(batch.exceptions[0].properties).toMatchObject({
      $exception_fingerprint: "slack.notify.failed:channel_not_found",
      $exception_level: "warning",
      error_kind: "integration",
      convex_handled: true,
      tenantId: "t1",
    });
  });

  test("a failure that propagates through nested calls is reported once", () => {
    const message = "Uncaught Error: boom";
    const batch = transformLogStreamBatch([
      failure("req4", message),
      failure("req4", message, { function: { type: "action", path: "a:b", request_id: "req4" } }),
    ]);
    expect(batch.exceptions).toHaveLength(1);
    expect(batch.logs).toHaveLength(2);
  });

  test("an error reported with reportError and then rethrown is reported once", () => {
    const line = captureConsoleLine(() =>
      reportError("slack.interactivity.create_lead_failed", new Error("boom")),
    );
    const batch = transformLogStreamBatch([
      consoleEvent("req7", line),
      failure("req7", "Uncaught Error: boom"),
    ]);
    expect(batch.exceptions).toHaveLength(1);
    expect(batch.exceptions[0].properties.convex_handled).toBe(true);
  });

  test("successful executions are only logged when slow or retried", () => {
    const success = (executionTimeMs: number, retries = 0): LogStreamEvent => ({
      topic: "function_execution",
      timestamp: 1,
      convex,
      function: { type: "query", path: "dashboard:get", request_id: "r" },
      status: "success",
      execution_time_ms: executionTimeMs,
      mutation_retry_count: retries,
    });
    const batch = transformLogStreamBatch([
      success(20),
      success(5_000),
      success(20, 2),
      { topic: "verification", timestamp: 1, message: "Convex connection test" },
    ]);
    expect(batch.logs.map((entry) => entry.body)).toEqual([
      "convex.function.slow dashboard:get",
      "convex.function.write_conflict_retried dashboard:get",
    ]);
  });

  test("a write-conflict failure is logged, not reported", () => {
    const batch = transformLogStreamBatch([
      failure("req8", "Uncaught Error: Documents changed", { occ_info: { table_name: "meetings" } }),
    ]);
    expect(batch.exceptions).toHaveLength(0);
    expect(batch.logs[0]).toMatchObject({ severity: "warn", body: "convex.function.write_conflict closer/payments:logPayment" });
  });

  test("a nested call is classified by the request's outermost caller", () => {
    const nested = failure("req9", "Uncaught Error: Opportunity not found", {
      run_reason: "action",
      function: { type: "mutation", path: "closer/followUpMutations:create", request_id: "req9" },
    });
    const outer = failure("req9", "Uncaught Error: Opportunity not found", {
      run_reason: "webSocket",
      function: { type: "action", path: "closer/followUp:createFollowUp", request_id: "req9" },
    });
    const batch = transformLogStreamBatch([nested, outer]);
    expect(batch.exceptions).toHaveLength(0);
    expect(batch.events).toHaveLength(1);
  });

  test("repeats of one failure collapse into one exception with a count", () => {
    const batch = transformLogStreamBatch([
      failure("a", "Uncaught Error: boom", { run_reason: "dataChange" }),
      failure("b", "Uncaught Error: boom", { run_reason: "dataChange" }),
      failure("c", "Uncaught Error: boom", { run_reason: "dataChange" }),
    ]);
    expect(batch.exceptions).toHaveLength(1);
    expect(batch.exceptions[0].properties.occurrences_in_batch).toBe(3);
  });

  test("exception and event ids are stable across retries", () => {
    const events = [failure("req10", "Uncaught Error: boom"), failure("req11", "Uncaught Error: Insufficient permissions")];
    const first = transformLogStreamBatch(events);
    const second = transformLogStreamBatch(events);
    expect(first.exceptions[0].uuid).toBe(second.exceptions[0].uuid);
    expect(first.events[0].uuid).toBe(second.events[0].uuid);
    expect(first.exceptions[0].uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("component functions keep their component in the path", () => {
    const batch = transformLogStreamBatch([
      failure("req12", "Uncaught Error: boom", {
        function: { type: "action", path: "lib:capture", component_path: "posthog", request_id: "req12" },
      }),
    ]);
    expect(batch.exceptions[0].properties.convex_function).toBe("posthog/lib:capture");
  });

  test("a truncated reportError line still becomes an exception", () => {
    const batch = transformLogStreamBatch([
      {
        ...consoleEvent("req13", {
          level: "ERROR",
          message: inspectString('[obs] slack.notify.failed {"obs_kind":"exception","error":{"message":"bo'),
        }),
        is_truncated: true,
      },
    ]);
    expect(batch.exceptions).toHaveLength(1);
    expect(batch.exceptions[0].properties.$exception_fingerprint).toBe("convex-handled:slack.notify.failed:truncated");
  });

  test("names, argument dumps, and phone numbers are redacted from errors", () => {
    const batch = transformLogStreamBatch([
      failure("req14", 'Uncaught Error: Lead "Jane Doe" is lost', { run_reason: "scheduler" }),
      failure(
        "req15",
        "Uncaught ArgumentValidationError: Value does not match validator.\nPath: .fullName\nValue: \"Jane Doe\"\nValidator: v.id(\"leads\")",
        { run_reason: "scheduler" },
      ),
      consoleEvent("req16", { level: "LOG", message: inspectString("call 555-123-4567 at calendly.com/jane-doe/30min") }),
    ]);
    const messages = batch.exceptions.map((exception) => exception.error.message).join("\n");
    expect(messages).not.toContain("Jane");
    expect(batch.logs.find((entry) => entry.body.startsWith("call"))?.body).toBe(
      "call <phone> at calendly.com/<slug>/30min",
    );
  });

  test("rejection events carry the normalized message, not user input", () => {
    const batch = transformLogStreamBatch([
      failure("req17", 'Uncaught Error: Invalid Fathom link "https://fathom.video/jane"'),
    ]);
    expect(batch.events[0].properties.error_message).toBe("Invalid Fathom link <value>");
  });

  test("emails are redacted from logs and errors", () => {
    const batch = transformLogStreamBatch([
      consoleEvent("req6", { level: "LOG", message: inspectString("[Pipeline] email=jane.doe@example.com") }),
      failure("req6", "Uncaught Error: No user jane@example.co.uk"),
    ]);
    expect(batch.logs[0].body).toBe("[Pipeline] email=<email>");
    expect(batch.exceptions[0].error.message).toBe("No user <email>");
  });

  test("plain console lines are forwarded unquoted", () => {
    const batch = transformLogStreamBatch([
      consoleEvent("req5", { level: "LOG", message: inspectString("[Pipeline] it's running") }),
    ]);
    expect(batch.logs[0]).toMatchObject({ severity: "info", body: "[Pipeline] it's running" });
  });
});

describe("parseLogStreamBody", () => {
  test("accepts a JSON array or JSONL", () => {
    const event = { topic: "verification", timestamp: 1 };
    expect(parseLogStreamBody(JSON.stringify([event, event]))).toHaveLength(2);
    expect(parseLogStreamBody(`${JSON.stringify(event)}\n${JSON.stringify(event)}\n`)).toHaveLength(2);
  });

  test("skips null entries and malformed lines", () => {
    const event = { topic: "verification", timestamp: 1 };
    expect(parseLogStreamBody(JSON.stringify([event, null, 3]))).toHaveLength(1);
    expect(parseLogStreamBody(`${JSON.stringify(event)}\n{broken\n`)).toHaveLength(1);
  });
});

describe("convexExceptionBeforeSend", () => {
  const exception = (type: string, value: string) => ({
    uuid: "u",
    event: "$exception",
    properties: { $exception_list: [{ type, value }] },
  });

  test("drops expected ConvexErrors", () => {
    expect(
      convexExceptionBeforeSend(exception("ConvexError", "[CONVEX M(closer/payments:logPayment)] [Request ID: abc] Server Error")),
    ).toBeNull();
  });

  test("turns Convex server errors into convex_call_failed events", () => {
    const result = convexExceptionBeforeSend(
      exception("Error", "[CONVEX M(closer/payments:logPayment)] [Request ID: abc123] Server Error\n  Called by client"),
    );
    expect(result?.event).toBe("convex_call_failed");
    expect(result?.properties).toEqual({
      error_origin: "convex_client",
      convex_function: "closer/payments:logPayment",
      convex_function_type: "mutation",
      convex_request_id: "abc123",
    });
  });

  test("drops browser noise", () => {
    for (const [type, value] of [
      ["ChunkLoadError", "Loading chunk 123 failed."],
      ["Error", "ResizeObserver loop completed with undelivered notifications."],
      ["AbortError", "The operation was aborted."],
      ["Error", "An error occurred in the Server Components render. The specific message is omitted"],
      ["Error", "[CONVEX A(closer/followUp:createFollowUp)] Connection lost while action was in flight"],
    ]) {
      expect(convexExceptionBeforeSend(exception(type, value)), value).toBeNull();
    }
  });

  test("groups hydration and network errors", () => {
    expect(
      convexExceptionBeforeSend(exception("Error", "Minified React error #418; visit https://react.dev"))?.properties
        .$exception_fingerprint,
    ).toBe("react-hydration:418");
    expect(
      convexExceptionBeforeSend(exception("TypeError", "Failed to fetch"))?.properties.$exception_fingerprint,
    ).toBe("network:fetch_failed");
  });

  test("leaves other exceptions alone", () => {
    const event = exception("TypeError", "x is undefined");
    expect(convexExceptionBeforeSend(event)).toBe(event);
  });
});

describe("readPostHogCookie", () => {
  test("reads the distinct id and session id", () => {
    const value = encodeURIComponent(
      JSON.stringify({ distinct_id: "user_1", $sesid: [1, "0199-session", 1] }),
    );
    expect(readPostHogCookie(`a=b; ph_phc_x_posthog=${value}`, "phc_x")).toEqual({
      distinctId: "user_1",
      sessionId: "0199-session",
    });
    expect(readPostHogCookie("a=b", "phc_x")).toEqual({});
  });
});

describe("buildOtlpLogsPayload", () => {
  test("encodes typed attributes and drops empty ones", () => {
    const payload = buildOtlpLogsPayload({ "service.name": "magnus-convex" }, [
      { timestamp: 1_000, severity: "warn", body: "x", attributes: { a: 1, b: 1.5, c: true, d: undefined, e: "s" } },
    ]);
    const record = payload.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(record).toMatchObject({ timeUnixNano: "1000000000", severityText: "WARN", severityNumber: 13 });
    expect(record.attributes).toEqual([
      { key: "a", value: { intValue: "1" } },
      { key: "b", value: { doubleValue: 1.5 } },
      { key: "c", value: { boolValue: true } },
      { key: "e", value: { stringValue: "s" } },
    ]);
  });
});
