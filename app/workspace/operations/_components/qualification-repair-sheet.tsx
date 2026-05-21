"use client";

import { AlertTriangleIcon } from "lucide-react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { QualificationRow } from "./qualification-table";

type QualificationRepairSheetProps = {
  row: QualificationRow | null;
  onOpenChange: (open: boolean) => void;
};

const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function DetailRow({ label, value }: { label: string; value?: string | number }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words">{value || "-"}</span>
    </div>
  );
}

export function QualificationRepairSheet({
  row,
  onOpenChange,
}: QualificationRepairSheetProps) {
  return (
    <Sheet open={Boolean(row)} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Qualification Repair</SheetTitle>
          <SheetDescription>
            Diagnostics for a Slack qualification row without a linked opportunity.
          </SheetDescription>
        </SheetHeader>

        {row ? (
          <div className="flex flex-col gap-4 px-4">
            <Alert>
              <AlertTriangleIcon />
              <AlertTitle>Unlinked qualification</AlertTitle>
              <AlertDescription>
                This accepted Slack submission has no opportunity link. Keep it in
                the queue until a repair path is added or the source event is
                reviewed manually.
              </AlertDescription>
            </Alert>

            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">{row.resultKind}</Badge>
              <Badge variant="outline">{row.attributionResolution}</Badge>
            </div>

            <div className="flex flex-col gap-3">
              <DetailRow label="Event ID" value={row.qualificationEventId} />
              <DetailRow label="Lead snapshot" value={row.fullNameSnapshot} />
              <DetailRow label="Handle" value={row.handleSnapshot} />
              <DetailRow label="Platform" value={row.platform} />
              <DetailRow label="Slack user" value={row.slackUserLabel ?? row.slackUserId} />
              <DetailRow label="Slack team" value={row.slackTeamId} />
              <DetailRow
                label="Submitted"
                value={DATE_FORMATTER.format(new Date(row.qualifiedAt))}
              />
              <DetailRow label="Lead ID" value={row.leadId} />
            </div>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
