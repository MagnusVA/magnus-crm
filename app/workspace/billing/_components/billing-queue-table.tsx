"use client";

import Link from "next/link";
import type { FunctionReturnType } from "convex/server";
import {
  AlertCircleIcon,
  ClipboardListIcon,
  ExternalLinkIcon,
  FileCheckIcon,
  InboxIcon,
} from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatAmountMinor } from "@/lib/format-currency";

type BillingPaymentRow =
  FunctionReturnType<typeof api.billing.queries.listPayments>["page"][number];

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const PAYMENT_TYPE_LABELS: Record<BillingPaymentRow["payment"]["paymentType"], string> = {
  monthly: "Monthly",
  split: "Split",
  pif: "Paid in full",
  deposit: "Deposit",
};

const STATUS_LABELS: Record<BillingPaymentRow["payment"]["status"], string> = {
  recorded: "Needs review",
  verified: "Reviewed",
  disputed: "Disputed",
};

function statusVariant(status: BillingPaymentRow["payment"]["status"]) {
  if (status === "verified") return "secondary";
  if (status === "disputed") return "destructive";
  return "outline";
}

function customerLabel(row: BillingPaymentRow) {
  return (
    row.customer.fullName ||
    row.customer.email ||
    row.customer.phone ||
    "Missing customer"
  );
}

function BillingTableSkeleton() {
  return (
    <div aria-label="Loading billing rows" role="status">
      <Skeleton className="h-[440px] w-full" />
    </div>
  );
}

export function BillingQueueTable({
  rows,
  exactCount,
  canLoadMore,
  isLoadingFirstPage,
  isLoadingMore,
  isInvalidRange,
  onLoadMore,
}: {
  rows: BillingPaymentRow[];
  exactCount: number | undefined;
  canLoadMore: boolean;
  isLoadingFirstPage: boolean;
  isLoadingMore: boolean;
  isInvalidRange: boolean;
  onLoadMore: () => void;
}) {
  if (isInvalidRange) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <AlertCircleIcon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>Select a Valid Date Range</EmptyTitle>
        </EmptyHeader>
        <EmptyContent>
          The paid-through date must be after the paid-from date.
        </EmptyContent>
      </Empty>
    );
  }

  if (isLoadingFirstPage) {
    return <BillingTableSkeleton />;
  }

  if (rows.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <InboxIcon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>No Payments Found</EmptyTitle>
        </EmptyHeader>
        <EmptyContent>
          No payment records match the current Billing filters.
        </EmptyContent>
      </Empty>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="overflow-hidden rounded-lg border bg-card">
        <ScrollArea className="w-full">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-36">Paid at</TableHead>
                <TableHead className="min-w-44">Customer</TableHead>
                <TableHead className="min-w-28">Amount</TableHead>
                <TableHead className="max-w-40">Program</TableHead>
                <TableHead className="min-w-28">Type</TableHead>
                <TableHead className="min-w-28">Status</TableHead>
                <TableHead className="w-16 text-right">Open</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.payment.id}>
                  <TableCell className="whitespace-nowrap text-sm">
                    {dateTimeFormatter.format(new Date(row.payment.recordedAt))}
                  </TableCell>
                  <TableCell>
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate font-medium">
                        {customerLabel(row)}
                      </span>
                      {row.customer.email ? (
                        <span className="truncate text-xs text-muted-foreground">
                          {row.customer.email}
                        </span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="font-medium">
                    {formatAmountMinor(
                      row.payment.amountMinor,
                      row.payment.currency,
                    )}
                  </TableCell>
                  <TableCell className="max-w-40">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="block truncate">
                          {row.payment.programName}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>{row.payment.programName}</TooltipContent>
                    </Tooltip>
                  </TableCell>
                  <TableCell>
                    {PAYMENT_TYPE_LABELS[row.payment.paymentType]}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Badge variant={statusVariant(row.payment.status)}>
                        {STATUS_LABELS[row.payment.status]}
                      </Badge>
                      {row.payment.hasProofFile ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span
                              aria-label="Proof file attached"
                              className="inline-flex text-muted-foreground"
                              tabIndex={0}
                            >
                              <FileCheckIcon aria-hidden="true" />
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>Proof file attached</TooltipContent>
                        </Tooltip>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          aria-label="Open payment"
                          asChild
                          size="icon"
                          variant="ghost"
                        >
                          <Link href={`/workspace/billing/${row.payment.id}`}>
                            <ExternalLinkIcon aria-hidden="true" />
                          </Link>
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Open payment</TooltipContent>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollArea>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
        <span>
          Showing {rows.length}
          {exactCount !== undefined ? ` of ${exactCount}` : ""} payments
        </span>
        <Button
          disabled={!canLoadMore || isLoadingMore}
          onClick={onLoadMore}
          size="sm"
          variant="outline"
        >
          <ClipboardListIcon aria-hidden="true" data-icon="inline-start" />
          {isLoadingMore ? "Loading" : "Load more"}
        </Button>
      </div>
    </div>
  );
}
