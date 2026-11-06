"use client";

import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { usePaginatedQuery, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { PAYMENT_TYPES, type PaymentType } from "@/convex/lib/paymentTypes";
import type { BillingPaymentStatus } from "@/convex/billing/types";
import { Button } from "@/components/ui/button";
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
import { useNow } from "@/hooks/use-now";
import { cn } from "@/lib/utils";
import { PageBand } from "@/app/workspace/_components/page-band";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { detailLinkClass } from "@/app/workspace/closer/meetings/_components/detail-card";
import { BAND_BUTTON_WRAPPER, PAYMENT_TYPE_LABELS, plural, STATUS_LABELS } from "./billing-format";
import { QueueHeads, QueueRow, QueueRowsSkeleton, type BillingQueueRow } from "./billing-queue-rows";
import { ExportMenu } from "./export-menu";

const PAGE_SIZE = 25;
const ALL = "all";
const CARD_ID = "billing-payments";

/** The tabs' order and their `?status=` words; Needs review has none (the default). */
const TABS: Array<{ status: BillingPaymentStatus; param: string | null }> = [
  { status: "recorded", param: null },
  { status: "verified", param: "reviewed" },
  { status: "disputed", param: "disputed" },
];

function statusFromParam(value: string | null): BillingPaymentStatus {
  return TABS.find((tab) => tab.param !== null && tab.param === value)?.status ?? "recorded";
}

function tabId(status: BillingPaymentStatus) {
  return `billing-tab-${status}`;
}

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

/** A count that keeps its last value while its query reloads for new filters. */
function useKeptCount(fresh: number | undefined) {
  const [kept, setKept] = useState(fresh);
  if (fresh !== undefined && fresh !== kept) setKept(fresh);
  return fresh ?? kept;
}

const NO_COUNTS: Record<BillingPaymentStatus, undefined> = { recorded: undefined, verified: undefined, disputed: undefined };

const EMPTY_TITLE: Record<BillingPaymentStatus, string> = {
  recorded: "No payments need review.",
  verified: "No reviewed payments.",
  disputed: "No disputed payments.",
};

const EMPTY_HINT: Record<BillingPaymentStatus, string> = {
  recorded: "Payments appear here as closers and admins record them.",
  verified: "Payments move here once someone marks them reviewed.",
  disputed: "Voided payments move here.",
};

export function BillingPageClient() {
  usePageTitle("Billing");
  const now = useNow();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const status = statusFromParam(searchParams.get("status"));

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
    const shared = {
      ...(programFilter !== ALL ? { programId: programFilter as Id<"tenantPrograms"> } : {}),
      ...(paymentTypeFilter !== ALL ? { paymentType: paymentTypeFilter as PaymentType } : {}),
      ...(startAt !== undefined ? { startAt } : {}),
      ...(endAt !== undefined ? { endAt } : {}),
    };
    const args: BillingFilterArgs = { status, ...shared };
    return {
      args,
      shared,
      isValidRange: startAt === undefined || endAt === undefined || endAt > startAt,
    };
  }, [endDate, paymentTypeFilter, programFilter, startDate, status]);

  const valid = filterState.isValidRange;
  const queryArgs = valid ? filterState.args : "skip";
  // Counts come from an aggregate (one indexed count per status), so every
  // tab can carry its own.
  const counts: Record<BillingPaymentStatus, number | undefined> = {
    recorded: useKeptCount(
      useQuery(api.billing.queries.getPaymentCount, valid ? { ...filterState.shared, status: "recorded" } : "skip"),
    ),
    verified: useKeptCount(
      useQuery(api.billing.queries.getPaymentCount, valid ? { ...filterState.shared, status: "verified" } : "skip"),
    ),
    disputed: useKeptCount(
      useQuery(api.billing.queries.getPaymentCount, valid ? { ...filterState.shared, status: "disputed" } : "skip"),
    ),
  };
  const exactCount = counts[status];

  const queue = usePaginatedQuery(api.billing.queries.listPayments, queryArgs, {
    initialNumItems: PAGE_SIZE,
  });

  // A new tab or filter keeps the last rows on screen, dimmed, until its own
  // first page lands (DESIGN.md, Kept Data While Reloading).
  const argsKey = JSON.stringify(queryArgs);
  const fresh = valid && queue.status !== "LoadingFirstPage" ? queue.results : undefined;
  const freshKey = fresh ? `${argsKey}|${fresh.map((row) => row.payment.id).join(",")}` : undefined;
  const [kept, setKept] = useState<{ key: string; rows: BillingQueueRow[] } | null>(null);
  if (fresh && freshKey !== undefined && freshKey !== kept?.key) setKept({ key: freshKey, rows: fresh });
  const rows = fresh ?? (valid ? kept?.rows : undefined);
  const reloading = valid && fresh === undefined && kept !== null;

  const filtered = programFilter !== ALL || paymentTypeFilter !== ALL || startDate !== "" || endDate !== "";
  const clearFilters = () => {
    setProgramFilter(ALL);
    setPaymentTypeFilter(ALL);
    setStartDate("");
    setEndDate("");
  };

  const setStatus = (next: BillingPaymentStatus) => {
    const params = new URLSearchParams(window.location.search);
    const param = TABS.find((tab) => tab.status === next)?.param ?? null;
    if (param) params.set("status", param);
    else params.delete("status");
    const search = params.toString();
    window.history.replaceState(null, "", search ? `${pathname}?${search}` : pathname);
  };

  return (
    <div className="@container mx-auto flex w-full max-w-[1500px] min-w-0 flex-col gap-3.5 pb-6 short:gap-3">
      <PageBand
        title="Billing"
        description="Recorded payments to check before they go to external billing. Dates follow your browser’s time zone."
        actions={
          <div className={BAND_BUTTON_WRAPPER}>
            <ExportMenu disabled={!valid} filters={filterState.args} />
          </div>
        }
      >
        {/* Invalid dates have no counts; the tabs say nothing rather than an old number. */}
        <StatusTabs status={status} counts={valid ? counts : NO_COUNTS} onSelect={setStatus} />
      </PageBand>

      <section
        id={CARD_ID}
        role="tabpanel"
        aria-labelledby={tabId(status)}
        className="@container/payments min-w-0 overflow-hidden rounded-xl border border-border bg-card"
      >
        <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2">
          <div className="mr-auto flex min-w-0 flex-wrap items-baseline gap-x-2.5">
            <h2 className="text-[15px] font-semibold">Payments</h2>
            <span className="text-[13px] text-muted-foreground">
              {!valid ? "Check the dates" : exactCount === undefined ? "Counting…" : exactCount === 0 ? "0 payments" : `${plural(exactCount, "payment")} · newest first`}
            </span>
          </div>
          <div className="grid w-full grid-cols-2 gap-2 @2xl/payments:flex @2xl/payments:flex-wrap @2xl/payments:items-center @4xl/payments:w-auto">
            <Select value={programFilter} onValueChange={setProgramFilter}>
              <SelectTrigger aria-label="Program" size="sm" className="h-[30px] w-full text-[13px] @2xl/payments:w-44">
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
            <Select value={paymentTypeFilter} onValueChange={setPaymentTypeFilter}>
              <SelectTrigger aria-label="Payment type" size="sm" className="h-[30px] w-full text-[13px] @2xl/payments:w-36">
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
            {(
              [
                { id: "billing-start-date", label: "Paid from", value: startDate, set: setStartDate },
                { id: "billing-end-date", label: "Paid through", value: endDate, set: setEndDate },
              ] as const
            ).map((date) => (
              <div
                key={date.id}
                className="flex min-w-0 flex-col gap-1 text-[13px] text-muted-foreground @2xl/payments:flex-row @2xl/payments:items-center @2xl/payments:gap-2"
              >
                <label htmlFor={date.id} className="shrink-0">
                  {date.label}
                </label>
                <Input
                  aria-invalid={!valid}
                  aria-describedby={valid ? undefined : "billing-range-error"}
                  id={date.id}
                  type="date"
                  value={date.value}
                  onChange={(event) => date.set(event.target.value)}
                  className="h-[30px] w-full min-w-0 font-condensed text-[14px] font-semibold tabular-nums text-foreground @2xl/payments:w-[9.25rem]"
                />
              </div>
            ))}
          </div>
        </div>

        {!valid ? (
          <p id="billing-range-error" role="alert" className="px-4 py-3 text-[13px] text-danger-ink">
            “Paid through” must be on or after “Paid from”. Change one of the dates to see payments.
          </p>
        ) : rows === undefined || (reloading && rows.length === 0) ? (
          <QueueRowsSkeleton />
        ) : rows.length === 0 ? (
          <SectionEmpty title={filtered ? `No ${STATUS_LABELS[status].toLowerCase()} payments match these filters.` : EMPTY_TITLE[status]}>
            {filtered ? (
              <button type="button" onClick={clearFilters} className={cn(detailLinkClass, "mt-1 text-[13px]")}>
                Clear filters
              </button>
            ) : (
              EMPTY_HINT[status]
            )}
          </SectionEmpty>
        ) : (
          <>
            <div
              aria-busy={reloading}
              className={cn("transition-opacity duration-200 motion-reduce:transition-none", reloading && "opacity-60")}
            >
              <QueueHeads />
              <ul aria-label={`${STATUS_LABELS[status]} payments`}>
                {rows.map((row) => (
                  <QueueRow key={row.payment.id} row={row} now={now} />
                ))}
              </ul>
            </div>
            <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-t px-4 py-1.5 text-[13px] text-muted-foreground">
              <span role="status" className="tabular-nums">
                {exactCount !== undefined && rows.length >= exactCount
                  ? `Showing all ${plural(rows.length, "payment")}`
                  : `Showing ${rows.length.toLocaleString("en-US")}${exactCount !== undefined ? ` of ${plural(exactCount, "payment")}` : " payments"}`}
              </span>
              {!reloading && (queue.status === "CanLoadMore" || queue.status === "LoadingMore") ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="ml-auto h-7"
                  disabled={queue.status === "LoadingMore"}
                  onClick={() => queue.loadMore(PAGE_SIZE)}
                >
                  {queue.status === "LoadingMore" ? "Loading…" : `Show ${PAGE_SIZE} more`}
                </Button>
              ) : null}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

/** NEEDS REVIEW · REVIEWED · DISPUTED, each with its count; arrows move between them. */
function StatusTabs({
  status,
  counts,
  onSelect,
}: {
  status: BillingPaymentStatus;
  counts: Record<BillingPaymentStatus, number | undefined>;
  onSelect: (status: BillingPaymentStatus) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  const select = (index: number) => {
    const tab = TABS[(index + TABS.length) % TABS.length];
    onSelect(tab.status);
    listRef.current?.querySelector<HTMLButtonElement>(`#${tabId(tab.status)}`)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = TABS.findIndex((tab) => tab.status === status);
    if (event.key === "ArrowRight") select(current + 1);
    else if (event.key === "ArrowLeft") select(current - 1);
    else if (event.key === "Home") select(0);
    else if (event.key === "End") select(TABS.length - 1);
    else return;
    event.preventDefault();
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="Payment status"
      onKeyDown={onKeyDown}
      className="-mx-4 flex items-center gap-[22px] overflow-x-auto border-t border-board-line px-4 [scrollbar-width:none] @lg:-mx-[18px] @lg:px-[18px]"
    >
      {TABS.map((tab) => {
        const selected = tab.status === status;
        const count = counts[tab.status];
        return (
          <button
            key={tab.status}
            id={tabId(tab.status)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={CARD_ID}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(tab.status)}
            className={cn(
              "flex h-10 shrink-0 items-center gap-[7px] border-b-2 font-condensed text-[13px] font-semibold tracking-[0.12em] whitespace-nowrap uppercase outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              selected ? "border-primary text-board-foreground" : "border-transparent text-board-muted hover:text-board-foreground",
            )}
          >
            {STATUS_LABELS[tab.status]}
            {count !== undefined ? (
              <span
                className={cn(
                  "font-condensed text-[14px] tracking-[0.02em] tabular-nums",
                  tab.status === "recorded" && count > 0 ? "text-warning" : selected ? "text-board-foreground" : "text-board-muted",
                )}
              >
                {count.toLocaleString("en-US")}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
