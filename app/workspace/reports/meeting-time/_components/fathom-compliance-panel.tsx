import { VideoIcon } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { FathomCompliance } from "./meeting-time-report-helpers";
import { formatRate } from "./meeting-time-report-helpers";

interface FathomCompliancePanelProps {
  compliance: FathomCompliance;
}

export function FathomCompliancePanel({
  compliance,
}: FathomCompliancePanelProps) {
  const missingEvidence = Math.max(
    0,
    compliance.required - compliance.provided,
  );
  const progressValue = compliance.rate === null ? 0 : compliance.rate * 100;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <VideoIcon className="size-4 text-muted-foreground" />
          Fathom Compliance
        </CardTitle>
        <CardDescription>
          Evidence required = completed + flagged meetings.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <div className="text-4xl font-semibold tracking-tight tabular-nums">
              {formatRate(compliance.rate)}
            </div>
            <p className="text-sm text-muted-foreground">
              {compliance.provided} of {compliance.required} evidence-ready
              meetings include a Fathom link.
            </p>
          </div>

          <Progress
            value={progressValue}
            aria-label="Fathom compliance progress"
          />

          <div className="rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
            {compliance.required > 0
              ? "Missing evidence usually means the meeting was completed or flagged without a linked recording."
              : "No completed or flagged meetings matched this range, so no evidence was required."}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-1">
          <div className="rounded-lg border px-4 py-3">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Links Provided
            </p>
            <p className="mt-2 text-2xl font-semibold tabular-nums">
              {compliance.provided.toLocaleString()}
            </p>
          </div>
          <div className="rounded-lg border px-4 py-3">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Missing
            </p>
            <p className="mt-2 text-2xl font-semibold tabular-nums">
              {missingEvidence.toLocaleString()}
            </p>
          </div>
          <div className="rounded-lg border px-4 py-3">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Evidence Required
            </p>
            <p className="mt-2 text-2xl font-semibold tabular-nums">
              {compliance.required.toLocaleString()}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
