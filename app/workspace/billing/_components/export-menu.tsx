"use client";

import { useMemo, useState } from "react";
import { DownloadIcon } from "lucide-react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { PaymentType } from "@/convex/lib/paymentTypes";
import type { BillingPaymentStatus } from "@/convex/billing/types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { serializeCsv } from "@/lib/csv";
import { reportClientError } from "@/lib/observability/report-client-error";
import { getErrorMessage } from "@/lib/errors";

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

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button disabled={disabled} variant="outline">
          <DownloadIcon aria-hidden="true" data-icon="inline-start" />
          Export CSV
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 p-0">
        {/* The content mounts only while the menu shows, so the export
            query runs only then. */}
        <ExportMenuBody filters={filters} onExported={() => setOpen(false)} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ExportMenuBody({
  filters,
  onExported,
}: {
  filters: BillingExportFilterState;
  onExported: () => void;
}) {
  const [isDownloading, setIsDownloading] = useState(false);
  const exportData = useQuery(api.billing.queries.exportPayments, { ...filters, limit: EXPORT_LIMIT });
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
      onExported();
    } catch (error) {
      reportClientError(error, { flow: "billing_export" });
      toast.error(getErrorMessage(error, "Export failed."));
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <>
      <DropdownMenuLabel className="border-b px-3 py-2.5 text-[15px] font-semibold text-foreground">
        CSV export
      </DropdownMenuLabel>
      <div className="flex flex-col gap-2 px-3 py-2.5 text-[13px]">
        <p className="text-muted-foreground">
          Uses the tab and filters on screen, up to {EXPORT_LIMIT.toLocaleString("en-US")} rows.
        </p>
        {exportData ? (
          <dl className="flex flex-col">
            <div className="flex items-baseline justify-between border-b py-1.5">
              <dt className="text-muted-foreground">Matching</dt>
              <dd className="font-condensed text-[15px] font-semibold tabular-nums">
                {exportData.exactCount.toLocaleString("en-US")}
              </dd>
            </div>
            <div className="flex items-baseline justify-between py-1.5">
              <dt className="text-muted-foreground">In the file</dt>
              <dd className="font-condensed text-[15px] font-semibold tabular-nums">
                {exportData.exportedCount.toLocaleString("en-US")}
              </dd>
            </div>
          </dl>
        ) : (
          <p role="status" className="flex items-center gap-2 text-muted-foreground">
            <Spinner data-icon="inline-start" />
            Counting the rows…
          </p>
        )}
        {exportData?.truncated ? (
          <p className="font-medium text-warning-ink">
            Only the first {exportData.limit.toLocaleString("en-US")} matching rows go in the file.
          </p>
        ) : null}
      </div>
      <div className="border-t bg-background p-3">
        <Button
          className="w-full font-semibold"
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
      </div>
    </>
  );
}
