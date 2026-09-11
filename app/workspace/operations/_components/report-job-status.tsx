"use client";

import {
  CircleCheckIcon,
  CircleXIcon,
  Clock3Icon,
  RefreshCwIcon,
} from "lucide-react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

export type OperationsReportJobState =
  | "queued"
  | "running"
  | "rendering"
  | "ready"
  | "failed"
  | "canceled"
  | "expired";

function formatGeneratedAt(timestamp: number | null) {
  if (timestamp === null) return null;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

export function OperationsReportJobStatus({
  state,
  generatedAt,
  errorMessage,
  onCancel,
  onRetry,
  onRefresh,
}: {
  state: OperationsReportJobState;
  generatedAt: number | null;
  errorMessage: string | null;
  onCancel?: () => void;
  onRetry?: () => void;
  onRefresh?: () => void;
}) {
  const generatedLabel = formatGeneratedAt(generatedAt);
  const isActive =
    state === "queued" || state === "running" || state === "rendering";

  if (isActive) {
    const action =
      state === "queued"
        ? "Queued"
        : state === "rendering"
          ? "Rendering"
          : "Generating";
    return (
      <Alert aria-busy="true">
        <Spinner aria-label={`${action} report`} />
        <AlertTitle>{action} complete historical report</AlertTitle>
        <AlertDescription>
          This range is being prepared in the background. You can keep working
          while it finishes.
        </AlertDescription>
        {onCancel ? (
          <AlertAction>
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </AlertAction>
        ) : null}
      </Alert>
    );
  }

  if (state === "ready") {
    return (
      <Alert>
        <CircleCheckIcon aria-hidden="true" />
        <AlertTitle>Historical report ready</AlertTitle>
        <AlertDescription>
          {generatedLabel
            ? `Generated ${generatedLabel}.`
            : "The completed report is ready."}
        </AlertDescription>
        {onRefresh ? (
          <AlertAction>
            <Button size="sm" variant="outline" onClick={onRefresh}>
              <RefreshCwIcon data-icon="inline-start" />
              Refresh
            </Button>
          </AlertAction>
        ) : null}
      </Alert>
    );
  }

  const expired = state === "expired";
  return (
    <Alert variant="destructive">
      {expired ? <Clock3Icon aria-hidden="true" /> : <CircleXIcon aria-hidden="true" />}
      <AlertTitle>
        {expired ? "Historical report expired" : "Historical report unavailable"}
      </AlertTitle>
      <AlertDescription>
        {errorMessage ??
          (expired
            ? "This generated report is no longer available. Generate a fresh report to continue."
            : "The report could not be generated. Try again to request a new one.")}
      </AlertDescription>
      {onRetry ? (
        <AlertAction>
          <Button size="sm" variant="outline" onClick={onRetry}>
            <RefreshCwIcon data-icon="inline-start" />
            {expired ? "Generate again" : "Retry"}
          </Button>
        </AlertAction>
      ) : null}
    </Alert>
  );
}
