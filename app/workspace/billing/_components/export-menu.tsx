"use client";

import { useMemo, useState } from "react";
import { DownloadIcon } from "lucide-react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { PaymentType } from "@/convex/lib/paymentTypes";
import type { BillingPaymentStatus } from "@/convex/billing/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { serializeCsv } from "@/lib/csv";

const EXPORT_LIMIT = 1000;

const HEADERS = [
  "Payment ID",
  "Paid At",
  "Reviewed At",
  "Reviewer",
  "Customer Name",
  "Customer Email",
  "Customer Phone",
  "Amount",
  "Currency",
  "Program",
  "Payment Type",
  "Reference Code",
  "Internal Note",
  "Entered By",
  "Phone Closer",
  "DM Team",
  "DM Closer",
  "Slack Contributor",
  "Slack Contributor Count",
  "Opportunity ID",
  "Meeting ID",
  "Has Proof File",
] as const;

export type BillingExportFilterState = {
  status: BillingPaymentStatus;
  programId?: Id<"tenantPrograms">;
  paymentType?: PaymentType;
  startAt?: number;
  endAt?: number;
};

function isoDate(value: number | null) {
  return value ? new Date(value).toISOString() : "";
}

function downloadCsv(csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `billing-export-${Date.now()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export function ExportMenu({
  filters,
  disabled = false,
}: {
  filters: BillingExportFilterState;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [armed, setArmed] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const exportData = useQuery(
    api.billing.queries.exportPayments,
    armed ? { ...filters, limit: EXPORT_LIMIT } : "skip",
  );
  const recordExportAudit = useMutation(api.billing.mutations.recordExportAudit);

  const csv = useMemo(() => {
    if (!exportData) {
      return null;
    }
    return serializeCsv([
      [...HEADERS],
      ...exportData.rows.map((row) => [
        row.paymentId,
        isoDate(row.paidAt),
        isoDate(row.reviewedAt),
        row.reviewer,
        row.customerName,
        row.customerEmail,
        row.customerPhone,
        row.amount,
        row.currency,
        row.program,
        row.paymentType,
        row.referenceCode,
        row.note,
        row.enteredBy,
        row.phoneCloser,
        row.dmTeam,
        row.dmCloser,
        row.slackContributor,
        row.slackContributorCount,
        row.opportunityId,
        row.meetingId,
        row.hasProofFile ? "yes" : "no",
      ]),
    ]);
  }, [exportData]);

  const startDownload = async () => {
    if (!exportData || !csv) {
      setArmed(true);
      return;
    }

    setIsDownloading(true);
    try {
      await recordExportAudit({
        ...filters,
        limit: exportData.limit,
        exportedCount: exportData.exportedCount,
        truncated: exportData.truncated,
      });
      downloadCsv(csv);
      toast.success("Billing CSV exported.");
      setOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Export failed.");
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) {
          setArmed(true);
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button disabled={disabled} variant="outline">
          <DownloadIcon aria-hidden="true" data-icon="inline-start" />
          Export CSV
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 p-3">
        <DropdownMenuLabel className="px-0">CSV export</DropdownMenuLabel>
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-muted-foreground">
            Export uses the current queue filters and is capped at {EXPORT_LIMIT}
            rows.
          </p>
          {exportData ? (
            <div className="grid grid-cols-2 gap-2 rounded-md border p-2">
              <span className="text-muted-foreground">Matching</span>
              <span className="text-right font-medium">
                {exportData.exactCount}
              </span>
              <span className="text-muted-foreground">Exported</span>
              <span className="text-right font-medium">
                {exportData.exportedCount}
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Spinner data-icon="inline-start" />
              Preparing export preview
            </div>
          )}
          {exportData?.truncated ? (
            <Alert>
              <AlertDescription>
                The export is truncated to the first {exportData.limit} matching
                rows.
              </AlertDescription>
            </Alert>
          ) : null}
        </div>
        <DropdownMenuSeparator />
        <Button
          className="w-full"
          disabled={!exportData || isDownloading}
          onClick={startDownload}
        >
          {isDownloading ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <DownloadIcon aria-hidden="true" data-icon="inline-start" />
          )}
          Download CSV
        </Button>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
