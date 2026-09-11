"use client";

import {
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { DashboardRangeInput } from "@/app/workspace/_components/dashboard-date-range-filter";
import {
  type OperationsReportFormat,
  type OperationsReportKind,
  type OperationsReportSource,
  useOperationsReportExport,
} from "./use-operations-report-job";

const EXPORTS: Record<
  OperationsReportKind,
  readonly { format: OperationsReportFormat; label: string }[]
> = {
  "lead-gen": [
    { format: "summary_csv", label: "Summary CSV" },
    { format: "raw_csv", label: "Raw Submissions CSV" },
    { format: "xlsx", label: "Performance Excel" },
    { format: "pdf", label: "Report PDF" },
  ],
  qualifications: [
    { format: "summary_csv", label: "Summary CSV" },
    { format: "raw_csv", label: "Raw Qualifications CSV" },
    { format: "xlsx", label: "Performance Excel" },
    { format: "pdf", label: "Report PDF" },
  ],
  "booked-calls": [
    { format: "summary_csv", label: "Summary CSV" },
    { format: "raw_csv", label: "Raw Bookings CSV" },
    { format: "xlsx", label: "Performance Excel" },
    { format: "pdf", label: "Report PDF" },
  ],
  "sales-calls": [
    { format: "summary_csv", label: "Summary CSV" },
    { format: "raw_csv", label: "Raw Calls CSV" },
    { format: "payments_csv", label: "Raw Payments CSV" },
    { format: "xlsx", label: "Performance Excel" },
    { format: "pdf", label: "Report PDF" },
  ],
};

function exportStatusLabel(status: string | undefined) {
  if (status === "queued") return "Export queued";
  if (status === "rendering") return "Rendering export";
  if (status === "running") return "Generating export";
  if (status === "ready") return "Export ready";
  if (status === "expired") return "Export expired";
  if (status === "canceled") return "Export canceled";
  if (status === "failed") return "Export failed";
  return "Export";
}

function formatBytes(byteSize: number) {
  return byteSize < 1024 * 1024
    ? `${Math.ceil(byteSize / 1024)} KB`
    : `${(byteSize / (1024 * 1024)).toFixed(1)} MB`;
}

export function OperationsReportExportMenu({
  reportKind,
  range,
  sourceFilter,
}: {
  reportKind: OperationsReportKind;
  range: DashboardRangeInput;
  sourceFilter?: OperationsReportSource;
}) {
  const exportJob = useOperationsReportExport({
    reportKind,
    range,
    sourceFilter,
  });
  const isActive =
    exportJob.job?.status === "queued" ||
    exportJob.job?.status === "running" ||
    exportJob.job?.status === "rendering";
  const isTerminalFailure =
    exportJob.job?.status === "failed" ||
    exportJob.job?.status === "canceled" ||
    exportJob.job?.status === "expired";
  const statusMessage =
    exportJob.downloadError ??
    exportJob.requestError ??
    exportJob.job?.failure?.message ??
    null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button aria-busy={exportJob.isRequesting || isActive} size="sm" variant="outline">
          {exportJob.isRequesting || isActive ? (
            <LoaderCircleIcon className="animate-spin" data-icon="inline-start" />
          ) : (
            <DownloadIcon data-icon="inline-start" />
          )}
          {exportJob.isRequesting
            ? "Starting export"
            : isActive
              ? exportStatusLabel(exportJob.job?.status)
              : "Export"}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel>Selected report range</DropdownMenuLabel>
        <DropdownMenuGroup>
          {EXPORTS[reportKind].map((exportOption) => (
            <DropdownMenuItem
              key={exportOption.format}
              disabled={exportJob.isRequesting || isActive}
              onSelect={() => void exportJob.start(exportOption.format)}
            >
              {exportOption.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        {exportJob.job || exportJob.requestError || exportJob.downloadError ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>
              {exportStatusLabel(exportJob.job?.status)}
            </DropdownMenuLabel>
            {statusMessage ? (
              <p className="px-1.5 pb-1 text-xs text-muted-foreground">
                {statusMessage}
              </p>
            ) : null}
            {isActive ? (
              <DropdownMenuItem onSelect={() => void exportJob.cancel()}>
                <XIcon data-icon="inline-start" />
                Cancel export
              </DropdownMenuItem>
            ) : isTerminalFailure || exportJob.requestError || exportJob.downloadError ? (
              <DropdownMenuItem onSelect={() => void exportJob.retry()}>
                <RefreshCwIcon data-icon="inline-start" />
                Retry export
              </DropdownMenuItem>
            ) : null}
            {exportJob.job?.status === "ready" ? (
              <div className="flex flex-col gap-1 px-1.5 pb-1">
                <p className="text-xs text-muted-foreground">
                  Download each generated file below. Failed downloads can be
                  retried without regenerating the report.
                </p>
                {exportJob.artifacts === undefined ? (
                  <p className="py-2 text-xs text-muted-foreground" role="status">
                    Loading report files…
                  </p>
                ) : (
                  exportJob.artifacts.map((artifact) => {
                    const artifactKey = `${exportJob.job?.jobId}:${artifact.artifactId}`;
                    const downloadState = exportJob.artifactDownloadState[artifactKey];
                    return (
                      <Button
                        key={artifact.artifactId}
                        className="h-auto justify-between gap-3 px-2 py-2"
                        disabled={
                          !artifact.available ||
                          downloadState === "downloading"
                        }
                        size="sm"
                        variant="ghost"
                        onClick={() => void exportJob.downloadArtifact(artifact)}
                      >
                        <span className="min-w-0 truncate">{artifact.filename}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {downloadState === "downloading"
                            ? "Downloading…"
                            : downloadState === "failed"
                              ? "Retry"
                              : downloadState === "downloaded"
                                ? "Download again"
                                : formatBytes(artifact.byteSize)}
                        </span>
                      </Button>
                    );
                  })
                )}
                {exportJob.hasPreviousArtifactPage || exportJob.hasNextArtifactPage ? (
                  <div className="flex justify-end gap-1 pt-1">
                    <Button
                      aria-label="Previous report files"
                      disabled={!exportJob.hasPreviousArtifactPage}
                      size="icon-sm"
                      variant="outline"
                      onClick={exportJob.previousArtifactPage}
                    >
                      <ChevronLeftIcon />
                    </Button>
                    <Button
                      aria-label="Next report files"
                      disabled={!exportJob.hasNextArtifactPage}
                      size="icon-sm"
                      variant="outline"
                      onClick={exportJob.nextArtifactPage}
                    >
                      <ChevronRightIcon />
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
