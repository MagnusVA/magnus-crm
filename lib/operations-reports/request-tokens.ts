import type {
  ReportFormat,
  ReportKind,
  ReportRangeInput,
  ReportSourceFilter,
} from "@/convex/operations/reports/contracts";

/** Identifies a report's inputs; changes whenever the requested report would. */
export function reportScopeKey(args: {
  reportKind: ReportKind;
  range: ReportRangeInput;
  sourceFilter?: ReportSourceFilter;
  version?: number;
}) {
  return JSON.stringify({
    reportKind: args.reportKind,
    businessDayVersion: args.version ?? 0,
    range: args.range,
    sourceFilter: args.sourceFilter ?? "all",
  });
}

function compactScopeKey(scopeKey: string) {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < scopeKey.length; index += 1) {
    const code = scopeKey.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
}

// Request tokens carry a hash of the scope, not the scope itself: the server
// caps tokens at 200 characters and a custom-range scope alone can exceed it.
export function dashboardRequestToken(mountId: string, scopeKey: string, attempt: number) {
  return `operations-dashboard:${mountId}:${compactScopeKey(scopeKey)}:${attempt}`;
}

export function exportRequestToken(scopeKey: string, format: ReportFormat, requestedAt: number) {
  return `operations-export:${compactScopeKey(scopeKey)}:${format}:${requestedAt}`;
}
