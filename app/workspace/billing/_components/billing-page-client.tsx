"use client";

import { useMemo, useState } from "react";
import { usePaginatedQuery, useQuery } from "convex/react";
import { ClipboardListIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { PAYMENT_TYPES, type PaymentType } from "@/convex/lib/paymentTypes";
import type { BillingPaymentStatus } from "@/convex/billing/types";
import { Badge } from "@/components/ui/badge";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePageTitle } from "@/hooks/use-page-title";
import { BillingQueueTable } from "./billing-queue-table";
import { ExportMenu } from "./export-menu";

const PAGE_SIZE = 25;
const ALL = "all";

const PAYMENT_TYPE_LABELS: Record<PaymentType, string> = {
  monthly: "Monthly",
  split: "Split",
  pif: "Paid in full",
  deposit: "Deposit",
};

const STATUS_LABELS: Record<BillingPaymentStatus, string> = {
  recorded: "Needs review",
  verified: "Reviewed",
  disputed: "Disputed",
};

type BillingFilterArgs = {
  status: BillingPaymentStatus;
  programId?: Id<"tenantPrograms">;
  paymentType?: PaymentType;
  startAt?: number;
  endAt?: number;
};

function dateInputToStart(value: string) {
  if (!value) return undefined;
  const timestamp = new Date(`${value}T00:00:00`).getTime();
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function dateInputToEndExclusive(value: string) {
  if (!value) return undefined;
  const date = new Date(`${value}T00:00:00`);
  if (!Number.isFinite(date.getTime())) return undefined;
  date.setDate(date.getDate() + 1);
  return date.getTime();
}

export function BillingPageClient() {
  usePageTitle("Billing");

  const [status, setStatus] = useState<BillingPaymentStatus>("recorded");
  const [programFilter, setProgramFilter] = useState<string>(ALL);
  const [paymentTypeFilter, setPaymentTypeFilter] = useState<string>(ALL);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const programs = useQuery(api.tenantPrograms.queries.listPrograms, {
    includeArchived: true,
  });

  const filterState = useMemo(() => {
    const startAt = dateInputToStart(startDate);
    const endAt = dateInputToEndExclusive(endDate);
    const args: BillingFilterArgs = {
      status,
      ...(programFilter !== ALL
        ? { programId: programFilter as Id<"tenantPrograms"> }
        : {}),
      ...(paymentTypeFilter !== ALL
        ? { paymentType: paymentTypeFilter as PaymentType }
        : {}),
      ...(startAt !== undefined ? { startAt } : {}),
      ...(endAt !== undefined ? { endAt } : {}),
    };
    return {
      args,
      isValidRange:
        startAt === undefined || endAt === undefined || endAt > startAt,
    };
  }, [endDate, paymentTypeFilter, programFilter, startDate, status]);

  const queryArgs = filterState.isValidRange ? filterState.args : "skip";
  const exactCount = useQuery(api.billing.queries.getPaymentCount, queryArgs);
  const queue = usePaginatedQuery(api.billing.queries.listPayments, queryArgs, {
    initialNumItems: PAGE_SIZE,
  });

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
          <p className="text-sm text-muted-foreground">
            Review recorded payments before external billing handoff.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">
            <ClipboardListIcon aria-hidden="true" data-icon="inline-start" />
            {exactCount === undefined ? "Counting" : `${exactCount} matching`}
          </Badge>
          <ExportMenu
            disabled={!filterState.isValidRange}
            filters={filterState.args}
          />
        </div>
      </header>

      <FieldGroup className="grid gap-3 rounded-lg border bg-card p-3 md:grid-cols-5">
        <Field>
          <FieldLabel>Status</FieldLabel>
          <Select
            value={status}
            onValueChange={(value) =>
              setStatus(value as BillingPaymentStatus)
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {Object.entries(STATUS_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>

        <Field>
          <FieldLabel>Program</FieldLabel>
          <Select value={programFilter} onValueChange={setProgramFilter}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="All programs" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={ALL}>All programs</SelectItem>
                {(programs ?? []).map((program) => (
                  <SelectItem key={program._id} value={program._id}>
                    {program.name}
                    {program.archivedAt ? " (archived)" : ""}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>

        <Field>
          <FieldLabel>Payment type</FieldLabel>
          <Select
            value={paymentTypeFilter}
            onValueChange={setPaymentTypeFilter}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="All types" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={ALL}>All types</SelectItem>
                {PAYMENT_TYPES.map((paymentType) => (
                  <SelectItem key={paymentType} value={paymentType}>
                    {PAYMENT_TYPE_LABELS[paymentType]}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>

        <Field data-invalid={!filterState.isValidRange}>
          <FieldLabel htmlFor="billing-start-date">Paid from</FieldLabel>
          <Input
            aria-invalid={!filterState.isValidRange}
            id="billing-start-date"
            type="date"
            value={startDate}
            onChange={(event) => setStartDate(event.target.value)}
          />
        </Field>

        <Field data-invalid={!filterState.isValidRange}>
          <FieldLabel htmlFor="billing-end-date">Paid through</FieldLabel>
          <Input
            aria-invalid={!filterState.isValidRange}
            id="billing-end-date"
            type="date"
            value={endDate}
            onChange={(event) => setEndDate(event.target.value)}
          />
        </Field>
      </FieldGroup>

      <BillingQueueTable
        canLoadMore={queue.status === "CanLoadMore"}
        exactCount={exactCount}
        isInvalidRange={!filterState.isValidRange}
        isLoadingFirstPage={queue.status === "LoadingFirstPage"}
        isLoadingMore={queue.status === "LoadingMore"}
        onLoadMore={() => queue.loadMore(PAGE_SIZE)}
        rows={queue.results}
      />
    </div>
  );
}
