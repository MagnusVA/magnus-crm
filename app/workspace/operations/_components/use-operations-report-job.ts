"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConvex, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { DashboardRangeInput } from "@/app/workspace/_components/dashboard-date-range-filter";
import { collectDashboardPages } from "@/lib/operations-reports/dashboard-pages";

export type OperationsReportKind =
  | "lead-gen"
  | "qualifications"
  | "booked-calls"
  | "sales-calls";

export type OperationsReportFormat =
  | "summary_csv"
  | "raw_csv"
  | "payments_csv"
  | "xlsx"
  | "pdf";

export type OperationsReportSource = "instagram" | "meta_business";

const REPORT_PAGE_SIZE = 50;
const MAX_CURSOR_HISTORY = 8;
const MAX_BROWSER_DOWNLOAD_BYTES = 16 * 1024 * 1024;

type OperationsReportArtifact = FunctionReturnType<
  typeof api.operations.reports.jobs.listReportArtifacts
>["page"][number];

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message.replace(/^Uncaught Error: /, "");
  }
  return "The report request could not be completed.";
}

function reportScopeKey(args: {
  reportKind: OperationsReportKind;
  range: DashboardRangeInput;
  sourceFilter?: OperationsReportSource;
}) {
  return JSON.stringify({
    reportKind: args.reportKind,
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

/**
 * Requests and follows a snapshot dashboard for an Operations page. The token
 * is unique to this mounted dashboard but stable across Strict Mode effect
 * replays. Requests are serialized so a scope change can cancel the previous
 * job before using the tenant's single dashboard-report slot.
 */
export function useOperationsDashboardReport(args: {
  reportKind: OperationsReportKind;
  range: DashboardRangeInput;
  sourceFilter?: OperationsReportSource;
  enabled: boolean;
}) {
  const requestDashboardReport = useMutation(
    api.operations.reports.jobs.requestDashboardReport,
  );
  const cancelReport = useMutation(api.operations.reports.jobs.cancelReport);
  const [jobState, setJobState] = useState<{
    requestToken: string;
    jobId: Id<"operationsReportJobs"> | null;
    error: string | null;
  }>({ requestToken: "", jobId: null, error: null });
  const [attempt, setAttempt] = useState(0);
  const [mountId] = useState(() => crypto.randomUUID());
  const { enabled, range, reportKind, sourceFilter } = args;
  const scopeKey = useMemo(
    () => reportScopeKey({ reportKind, range, sourceFilter }),
    [range, reportKind, sourceFilter],
  );
  const requestToken = useMemo(
    () =>
      `operations-dashboard:${mountId}:${compactScopeKey(scopeKey)}:${attempt}`,
    [attempt, mountId, scopeKey],
  );
  const activeRequestRef = useRef(requestToken);
  const requestedTokenRef = useRef<string | null>(null);
  const lastJobIdRef = useRef<Id<"operationsReportJobs"> | null>(null);
  const requestChainRef = useRef(Promise.resolve());

  useEffect(() => {
    activeRequestRef.current = requestToken;

    if (!enabled) {
      if (requestedTokenRef.current === null) return;
      requestedTokenRef.current = null;
      requestChainRef.current = requestChainRef.current
        .catch(() => undefined)
        .then(async () => {
          const previousJobId = lastJobIdRef.current;
          if (previousJobId === null) return;
          await cancelReport({ jobId: previousJobId });
          if (lastJobIdRef.current === previousJobId) {
            lastJobIdRef.current = null;
          }
        });
      return;
    }

    if (requestedTokenRef.current === requestToken) {
      return;
    }
    requestedTokenRef.current = requestToken;

    requestChainRef.current = requestChainRef.current
      .catch(() => undefined)
      .then(async () => {
        const previousJobId = lastJobIdRef.current;
        if (previousJobId !== null) {
          await cancelReport({ jobId: previousJobId });
          lastJobIdRef.current = null;
        }
        const result = await requestDashboardReport({
          reportKind,
          range,
          sourceFilter,
          requestToken,
        });
        lastJobIdRef.current = result.jobId;
        if (activeRequestRef.current === requestToken) {
          setJobState({ requestToken, jobId: result.jobId, error: null });
        }
      })
      .catch((error: unknown) => {
        if (activeRequestRef.current === requestToken) {
          setJobState({
            requestToken,
            jobId: null,
            error: getErrorMessage(error),
          });
        }
      });
  }, [
    enabled,
    cancelReport,
    range,
    reportKind,
    sourceFilter,
    requestDashboardReport,
    requestToken,
  ]);

  const jobId =
    jobState.requestToken === requestToken ? jobState.jobId : null;
  const requestError =
    jobState.requestToken === requestToken ? jobState.error : null;

  const job = useQuery(
    api.operations.reports.jobs.getReportJob,
    jobId === null ? "skip" : { jobId },
  );
  const summary = useQuery(
    api.operations.reports.jobs.getDashboardReportSummary,
    jobId === null || job?.status !== "ready" ? "skip" : { jobId },
  );

  const retry = useCallback(() => {
    requestedTokenRef.current = null;
    setAttempt((currentAttempt) => currentAttempt + 1);
  }, []);

  const cancel = useCallback(async () => {
    if (jobId === null) return;
    await cancelReport({ jobId });
    if (lastJobIdRef.current === jobId) lastJobIdRef.current = null;
  }, [cancelReport, jobId]);

  return {
    jobId,
    job,
    summary: summary ?? undefined,
    requestError,
    retry,
    refresh: retry,
    cancel,
  };
}

/**
 * Loads complete, immutable aggregate dimensions for the existing dashboard UI.
 * Each request is bounded; raw ledgers continue to use their own paginated lists.
 * Obsolete range requests never publish partial or stale data to the components.
 */
export function useAllOperationsReportRows(args: {
  jobId: Id<"operationsReportJobs"> | null;
  section: string;
  enabled: boolean;
}) {
  const convex = useConvex();
  type Row = FunctionReturnType<typeof api.operations.reports.jobs.listDashboardReportRows>["page"][number];
  const { jobId, section, enabled } = args;
  const scopeKey = `${jobId ?? "none"}:${section}`;
  const [result, setResult] = useState<{
    scopeKey: string;
    rows?: Row[];
    error: string | null;
  }>({ scopeKey: "", error: null });

  useEffect(() => {
    if (!enabled || jobId === null) return;
    let canceled = false;
    void collectDashboardPages(
      (cursor) => convex.query(api.operations.reports.jobs.listDashboardReportRows, {
        jobId,
        section,
        paginationOpts: { cursor, numItems: REPORT_PAGE_SIZE },
      }),
      () => canceled,
    ).then((rows) => {
      if (!canceled && rows !== undefined) setResult({ scopeKey, rows, error: null });
    }).catch((error: unknown) => {
      if (!canceled) setResult({ scopeKey, error: getErrorMessage(error) });
    });
    return () => { canceled = true; };
  }, [convex, jobId, section, enabled, scopeKey]);

  const current = enabled && result.scopeKey === scopeKey ? result : undefined;
  return {
    rows: current?.rows,
    error: current?.error ?? null,
    isLoading: enabled && current?.rows === undefined && !current?.error,
  };
}

/** Keeps only the visible report page plus a small cursor history. */
export function useOperationsReportRows(args: {
  jobId: Id<"operationsReportJobs"> | null;
  section: string;
  enabled: boolean;
}) {
  const pageScopeKey = `${args.jobId ?? "none"}:${args.section}`;
  const [pageState, setPageState] = useState<{
    scopeKey: string;
    cursor: string | null;
    previousCursors: (string | null)[];
  }>({ scopeKey: "", cursor: null, previousCursors: [] });
  const cursor =
    pageState.scopeKey === pageScopeKey ? pageState.cursor : null;
  const previousCursors =
    pageState.scopeKey === pageScopeKey ? pageState.previousCursors : [];
  const page = useQuery(
    api.operations.reports.jobs.listDashboardReportRows,
    args.enabled && args.jobId !== null
      ? {
          jobId: args.jobId,
          section: args.section,
          paginationOpts: { cursor, numItems: REPORT_PAGE_SIZE },
        }
      : "skip",
  );

  const nextPage = useCallback(() => {
    if (!page || page.isDone) return;
    setPageState((currentState) => ({
      scopeKey: pageScopeKey,
      cursor: page.continueCursor,
      previousCursors: [
        ...(currentState.scopeKey === pageScopeKey
          ? currentState.previousCursors
          : []),
        cursor,
      ].slice(-MAX_CURSOR_HISTORY),
    }));
  }, [cursor, page, pageScopeKey]);
  const previousPage = useCallback(() => {
    setPageState((currentState) => {
      if (currentState.scopeKey !== pageScopeKey) return currentState;
      const previousCursor = currentState.previousCursors.at(-1);
      if (previousCursor === undefined) return currentState;
      return {
        scopeKey: pageScopeKey,
        cursor: previousCursor,
        previousCursors: currentState.previousCursors.slice(0, -1),
      };
    });
  }, [pageScopeKey]);

  return {
    rows: page?.page,
    isLoading: args.enabled && page === undefined,
    hasNextPage: page !== undefined && !page.isDone,
    hasPreviousPage: previousCursors.length > 0,
    nextPage,
    previousPage,
  };
}

/**
 * Starts an export only after an explicit menu choice and downloads each ready
 * artifact once. Files are capped per browser Blob so multipart reports stay
 * usable without collecting the whole report in memory.
 */
export function useOperationsReportExport(args: {
  reportKind: OperationsReportKind;
  range: DashboardRangeInput;
  sourceFilter?: OperationsReportSource;
}) {
  const requestExport = useMutation(api.operations.reports.jobs.requestExport);
  const cancelReport = useMutation(api.operations.reports.jobs.cancelReport);
  const requestReportDownload = useMutation(
    api.operations.reports.jobs.requestReportDownload,
  );
  const [exportState, setExportState] = useState<{
    scopeKey: string;
    jobId: Id<"operationsReportJobs"> | null;
    format: OperationsReportFormat | null;
    error: string | null;
  }>({ scopeKey: "", jobId: null, format: null, error: null });
  const [isRequesting, setIsRequesting] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const { reportKind, range, sourceFilter } = args;
  const scopeKey = useMemo(
    () => reportScopeKey({ reportKind, range, sourceFilter }),
    [range, reportKind, sourceFilter],
  );
  const activeRequestRef = useRef<string | null>(null);
  const downloadedArtifactsRef = useRef(new Set<string>());
  const downloadingArtifactsRef = useRef(new Set<string>());
  const autoAttemptedArtifactsRef = useRef(new Set<string>());
  const [artifactDownloadState, setArtifactDownloadState] = useState<
    Record<string, "downloading" | "downloaded" | "failed">
  >({});
  const [artifactPageState, setArtifactPageState] = useState<{
    scopeKey: string;
    cursor: string | null;
    previousCursors: (string | null)[];
  }>({ scopeKey: "", cursor: null, previousCursors: [] });

  const activeExport = exportState.scopeKey === scopeKey ? exportState : null;
  const artifactCursor =
    artifactPageState.scopeKey === scopeKey
      ? artifactPageState.cursor
      : null;
  const artifactPreviousCursors =
    artifactPageState.scopeKey === scopeKey
      ? artifactPageState.previousCursors
      : [];
  const job = useQuery(
    api.operations.reports.jobs.getReportJob,
    activeExport?.jobId === null || activeExport === null
      ? "skip"
      : { jobId: activeExport.jobId },
  );
  const artifacts = useQuery(
    api.operations.reports.jobs.listReportArtifacts,
    activeExport?.jobId === null ||
      activeExport === null ||
      job?.status !== "ready"
      ? "skip"
      : {
          jobId: activeExport.jobId,
          paginationOpts: { cursor: artifactCursor, numItems: REPORT_PAGE_SIZE },
        },
  );

  const start = useCallback(
    async (format: OperationsReportFormat) => {
      if (isRequesting) return;
      const requestToken = `operations-export:${scopeKey}:${format}:${Date.now()}`;
      activeRequestRef.current = requestToken;
      setIsRequesting(true);
      setDownloadError(null);
      try {
        const result = await requestExport({
          reportKind,
          format,
          range,
          sourceFilter,
          requestToken,
        });
        if (activeRequestRef.current === requestToken) {
          setExportState({
            scopeKey,
            jobId: result.jobId,
            format,
            error: null,
          });
          setArtifactPageState({ scopeKey, cursor: null, previousCursors: [] });
          setArtifactDownloadState({});
        }
      } catch (error) {
        if (activeRequestRef.current === requestToken) {
          setExportState({ scopeKey, jobId: null, format, error: getErrorMessage(error) });
        }
      } finally {
        if (activeRequestRef.current === requestToken) {
          setIsRequesting(false);
        }
      }
    },
    [
      isRequesting,
      range,
      reportKind,
      requestExport,
      scopeKey,
      sourceFilter,
    ],
  );

  const downloadArtifact = useCallback(
    async (artifact: OperationsReportArtifact) => {
      if (activeExport?.jobId === null || activeExport === null) return;
      const artifactKey = `${activeExport.jobId}:${artifact.artifactId}`;
      if (
        !artifact.available ||
        downloadingArtifactsRef.current.has(artifactKey)
      ) {
        return;
      }
      downloadingArtifactsRef.current.add(artifactKey);
      setArtifactDownloadState((current) => ({ ...current, [artifactKey]: "downloading" }));
      setDownloadError(null);
      try {
        const download = await requestReportDownload({
          jobId: activeExport.jobId,
          artifactId: artifact.artifactId,
        });
        if (download.byteSize > MAX_BROWSER_DOWNLOAD_BYTES) {
          throw new Error("This report part is too large for a browser download.");
        }
        const response = await fetch(download.url);
        if (!response.ok) {
          throw new Error("The report file could not be downloaded.");
        }
        const contentLength = response.headers.get("content-length");
        if (
          contentLength !== null &&
          Number(contentLength) > MAX_BROWSER_DOWNLOAD_BYTES
        ) {
          throw new Error("This report part is too large for a browser download.");
        }
        const blob = await response.blob();
        if (blob.size > MAX_BROWSER_DOWNLOAD_BYTES) {
          throw new Error("This report part is too large for a browser download.");
        }
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = download.filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
        downloadedArtifactsRef.current.add(artifactKey);
        setArtifactDownloadState((current) => ({ ...current, [artifactKey]: "downloaded" }));
      } catch (error) {
        setDownloadError(getErrorMessage(error));
        setArtifactDownloadState((current) => ({ ...current, [artifactKey]: "failed" }));
      } finally {
        downloadingArtifactsRef.current.delete(artifactKey);
      }
    },
    [activeExport, requestReportDownload],
  );

  useEffect(() => {
    if (
      !artifacts ||
      !artifacts.isDone ||
      artifacts.page.length !== 1 ||
      activeExport?.jobId === null ||
      activeExport === null
    ) {
      return;
    }
    const artifact = artifacts.page[0];
    const artifactKey = `${activeExport.jobId}:${artifact.artifactId}`;
    if (autoAttemptedArtifactsRef.current.has(artifactKey)) return;
    autoAttemptedArtifactsRef.current.add(artifactKey);
    void downloadArtifact(artifact);
  }, [activeExport, artifacts, downloadArtifact]);

  const nextArtifactPage = useCallback(() => {
    if (!artifacts || artifacts.isDone) return;
    setArtifactPageState((current) => ({
      scopeKey,
      cursor: artifacts.continueCursor,
      previousCursors: [
        ...(current.scopeKey === scopeKey ? current.previousCursors : []),
        artifactCursor,
      ].slice(-MAX_CURSOR_HISTORY),
    }));
  }, [artifactCursor, artifacts, scopeKey]);

  const previousArtifactPage = useCallback(() => {
    setArtifactPageState((current) => {
      if (current.scopeKey !== scopeKey) return current;
      const previousCursor = current.previousCursors.at(-1);
      if (previousCursor === undefined) return current;
      return {
        scopeKey,
        cursor: previousCursor,
        previousCursors: current.previousCursors.slice(0, -1),
      };
    });
  }, [scopeKey]);

  const cancel = useCallback(async () => {
    if (activeExport?.jobId === null || activeExport === null) return;
    await cancelReport({ jobId: activeExport.jobId });
  }, [activeExport, cancelReport]);

  const retry = useCallback(() => {
    if (activeExport?.format === null || activeExport === null) return;
    void start(activeExport.format);
  }, [activeExport, start]);

  return {
    job,
    activeFormat: activeExport?.format ?? null,
    isRequesting,
    requestError: activeExport?.error ?? null,
    downloadError,
    artifacts: artifacts?.page,
    artifactDownloadState,
    downloadArtifact,
    hasNextArtifactPage: artifacts !== undefined && !artifacts.isDone,
    hasPreviousArtifactPage: artifactPreviousCursors.length > 0,
    nextArtifactPage,
    previousArtifactPage,
    start,
    retry,
    cancel,
  };
}
