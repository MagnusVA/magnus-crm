"use client";

import { useEffect, useState } from "react";
import { usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useNow } from "@/hooks/use-now";
import { cn } from "@/lib/utils";
import { SectionEmpty, SectionError } from "@/app/workspace/closer/_components/section-state";
import { CARD, LABEL } from "@/app/workspace/team/_components/team-ui";
import {
  EMPTY_FOR_STATUS,
  formatDay,
  formatFull,
  formatInviteEnd,
  hasOpenInvite,
  plural,
  TenantStatusWord,
  type TenantRow,
  type TenantStatus,
} from "./admin-ui";
import { statusTabId, TENANTS_PANEL_ID } from "./tenants-band";

const PAGE_SIZE = 25;

// The rows fold by the page's width (the page root is the container). From
// @3xl one 44px line: COMPANY · CONTACT · STATUS · CREATED · INVITE · actions.
// Below it two lines (company and status; contact · created · invite and the
// actions), and on a phone the contact takes a line of its own.
const COLUMNS =
  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 @3xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_7.5rem_5.25rem_6.75rem_8.5rem] @3xl:gap-x-3 @5xl:gap-x-4";

/** The tenants list, the band's tab panel. It reports what it shows to the band. */
export function TenantsCard({
  status,
  onSummary,
  onRegenerate,
  onDeleteRequest,
}: {
  status: TenantStatus | undefined;
  onSummary: (summary: string | null) => void;
  onRegenerate: (tenant: TenantRow) => Promise<void>;
  onDeleteRequest: (tenant: TenantRow) => void;
}) {
  const now = useNow();
  const queue = usePaginatedQuery(
    api.admin.tenantsQueries.listTenants,
    { statusFilter: status },
    { initialNumItems: PAGE_SIZE },
  );

  // A new tab keeps the last rows on screen, dimmed, until its own first page
  // lands (DESIGN.md, Kept Data While Reloading).
  const fresh = queue.status === "LoadingFirstPage" ? undefined : queue.results;
  const more = queue.status === "CanLoadMore" || queue.status === "LoadingMore";
  // Keyed by content, so a new array with the same rows doesn't loop.
  const freshKey = fresh
    ? `${status ?? "all"}|${more}|${fresh.map((tenant) => `${tenant._id}:${tenant.status}:${tenant.inviteExpiresAt}`).join(",")}`
    : undefined;
  const [kept, setKept] = useState<{ key: string; rows: TenantRow[]; more: boolean } | null>(null);
  if (fresh && freshKey !== undefined && freshKey !== kept?.key) {
    setKept({ key: freshKey, rows: fresh, more });
  }
  const shown = fresh ? { rows: fresh, more } : kept;
  const reloading = fresh === undefined && kept !== null;

  const summary =
    shown === null || shown.rows.length === 0
      ? null
      : shown.more
        ? `${shown.rows.length.toLocaleString("en-US")} shown · newest first`
        : `${plural(shown.rows.length, "tenant")} · newest first`;
  useEffect(() => onSummary(summary), [onSummary, summary]);

  return (
    <TenantsFrame status={status}>
      {shown === null || (reloading && shown.rows.length === 0) ? (
        <TenantRowsSkeleton />
      ) : shown.rows.length === 0 ? (
        status ? (
          <SectionEmpty title={EMPTY_FOR_STATUS[status]} />
        ) : (
          <SectionEmpty title="No tenants yet.">Create the first one with New tenant invite.</SectionEmpty>
        )
      ) : (
        <>
          <div
            aria-busy={reloading}
            className={cn("transition-opacity duration-200 motion-reduce:transition-none", reloading && "opacity-60")}
          >
            <TenantHeads />
            <ul aria-label="Tenants">
              {shown.rows.map((tenant) => (
                <TenantListRow
                  key={tenant._id}
                  tenant={tenant}
                  now={now}
                  onRegenerate={onRegenerate}
                  onDeleteRequest={onDeleteRequest}
                />
              ))}
            </ul>
          </div>
          {!reloading && more ? (
            <div className="flex min-h-10 items-center border-t px-4 py-1.5">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7"
                disabled={queue.status === "LoadingMore"}
                onClick={() => queue.loadMore(PAGE_SIZE)}
              >
                {queue.status === "LoadingMore" ? <Spinner data-icon="inline-start" /> : null}
                {queue.status === "LoadingMore" ? "Loading…" : "Load more"}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </TenantsFrame>
  );
}

function TenantsFrame({ status, children }: { status: TenantStatus | undefined; children: React.ReactNode }) {
  return (
    <section id={TENANTS_PANEL_ID} role="tabpanel" aria-labelledby={statusTabId(status)} className={CARD}>
      {children}
    </section>
  );
}

/** The card's error, said in place; the band stops counting. */
export function TenantsCardError({
  status,
  onSummary,
}: {
  status: TenantStatus | undefined;
  onSummary: (summary: string | null) => void;
}) {
  useEffect(() => onSummary(null), [onSummary]);
  return (
    <TenantsFrame status={status}>
      <SectionError what="tenants" />
    </TenantsFrame>
  );
}

function TenantHeads() {
  return (
    <div className={cn(COLUMNS, "hidden min-h-7 border-b px-4 pt-2 pb-1.5 @3xl:grid", LABEL)}>
      <span>Company</span>
      <span>Contact</span>
      <span>Status</span>
      <span>Created</span>
      <span>Invite</span>
      <span className="sr-only">Actions</span>
    </div>
  );
}

function TenantListRow({
  tenant,
  now,
  onRegenerate,
  onDeleteRequest,
}: {
  tenant: TenantRow;
  now: number;
  onRegenerate: (tenant: TenantRow) => Promise<void>;
  onDeleteRequest: (tenant: TenantRow) => void;
}) {
  const [regenerating, setRegenerating] = useState(false);
  const openInvite = hasOpenInvite(tenant.status);
  const expired = tenant.inviteExpiresAt < now;

  return (
    <li className={cn(COLUMNS, "gap-y-0.5 border-b px-4 py-2 last:border-b-0 @3xl:min-h-11 @3xl:py-1.5")}>
      <p
        className="col-start-1 row-start-1 truncate leading-5 font-semibold @3xl:col-start-1"
        title={tenant.companyName}
        translate="no"
      >
        {tenant.companyName}
      </p>
      <TenantStatusWord
        status={tenant.status}
        className="col-start-2 row-start-1 justify-self-end @3xl:col-start-3 @3xl:justify-self-start"
      />
      {/* Below @3xl one meta line under the name; from @3xl each part is its own column. */}
      <div className="col-span-2 row-start-2 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[13px] leading-[18px] text-muted-foreground @lg:flex-nowrap @3xl:contents">
        <span
          className="min-w-0 basis-full truncate @lg:flex-1 @lg:basis-auto @3xl:col-start-2 @3xl:row-start-1 @3xl:flex-none"
          title={tenant.contactEmail}
          translate="no"
        >
          {tenant.contactEmail}
        </span>
        <span aria-hidden="true" className="hidden @lg:inline @3xl:hidden">
          ·
        </span>
        <time
          dateTime={new Date(tenant._creationTime).toISOString()}
          title={`Created ${formatFull(tenant._creationTime)}`}
          className="shrink-0 font-condensed text-[14px] font-semibold tabular-nums @3xl:col-start-4 @3xl:row-start-1 @3xl:text-[15px] @3xl:text-foreground"
        >
          <span className="@3xl:sr-only">created </span>
          {formatDay(tenant._creationTime, now)}
        </time>
        {openInvite ? (
          <>
            <span aria-hidden="true" className="@3xl:hidden">
              ·
            </span>
            <time
              dateTime={new Date(tenant.inviteExpiresAt).toISOString()}
              title={`${expired ? "Expired" : "Expires"} ${formatFull(tenant.inviteExpiresAt)}`}
              className={cn(
                "shrink-0 whitespace-nowrap @3xl:col-start-5 @3xl:row-start-1",
                expired && "text-danger-ink",
              )}
            >
              {expired ? "expired " : "expires "}
              <span className="font-condensed text-[14px] font-semibold tabular-nums">
                {formatInviteEnd(tenant.inviteExpiresAt, now)}
              </span>
            </time>
          </>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center justify-end gap-1 pl-2 @3xl:col-start-6 @3xl:row-start-1 @3xl:pl-0">
          {openInvite ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7"
              disabled={regenerating}
              aria-label={`New invite link for ${tenant.companyName}`}
              onClick={async () => {
                setRegenerating(true);
                try {
                  await onRegenerate(tenant);
                } finally {
                  setRegenerating(false);
                }
              }}
            >
              {regenerating ? <Spinner data-icon="inline-start" /> : null}
              New link
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-muted-foreground hover:bg-destructive/10 hover:text-danger-ink focus-visible:text-danger-ink dark:hover:bg-destructive/15"
            aria-label={`Delete ${tenant.companyName}`}
            onClick={() => onDeleteRequest(tenant)}
          >
            Delete
          </Button>
        </div>
      </div>
    </li>
  );
}

/** Rows at the real heights while the first page loads: the real rows' grid and folds. */
function TenantRowsSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading tenants">
      <div className={cn(COLUMNS, "hidden min-h-7 border-b px-4 pt-2 pb-1.5 @3xl:grid")}>
        <Skeleton className="h-2.5 w-14" />
        <Skeleton className="h-2.5 w-12" />
        <Skeleton className="h-2.5 w-11" />
      </div>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className={cn(COLUMNS, "gap-y-0.5 border-b px-4 py-2 last:border-b-0 @3xl:min-h-11 @3xl:py-1.5")}>
          <div className="col-start-1 row-start-1 flex h-5 items-center">
            <Skeleton className="h-3.5 w-44 max-w-full" />
          </div>
          <Skeleton className="col-start-2 row-start-1 h-3 w-20 justify-self-end @3xl:col-start-3 @3xl:justify-self-start" />
          <div className="col-span-2 row-start-2 flex min-w-0 flex-wrap items-center gap-x-3 @lg:flex-nowrap @3xl:contents">
            <div className="flex h-[18px] min-w-0 basis-full items-center @lg:basis-auto @3xl:col-start-2 @3xl:row-start-1">
              <Skeleton className="h-3 w-56 max-w-full" />
            </div>
            <Skeleton className="h-3 w-16 @3xl:col-start-4 @3xl:row-start-1 @3xl:h-3.5 @3xl:w-12" />
            <Skeleton className="ml-auto h-7 w-16 @3xl:col-start-6 @3xl:row-start-1 @3xl:justify-self-end" />
          </div>
        </div>
      ))}
    </div>
  );
}
