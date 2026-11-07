"use client";

import { useRef, type KeyboardEvent } from "react";
import { PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PageBand } from "@/app/workspace/_components/page-band";
import { STATUS_TABS, TENANT_STATUS_LABEL, type TenantStatus } from "./admin-ui";

export const TENANTS_PANEL_ID = "admin-tenants";

export function statusTabId(status: TenantStatus | undefined) {
  return `admin-tab-${status ?? "all"}`;
}

/**
 * The page's band: the title, one line, the lime New tenant invite, and the
 * status tabs with what the list shows beside them.
 */
export function TenantsBand({
  status,
  onStatus,
  summary,
  onCreate,
}: {
  status: TenantStatus | undefined;
  onStatus: (status: TenantStatus | undefined) => void;
  /** "12 tenants · newest first", or null while there's nothing to count. */
  summary: string | null;
  onCreate: () => void;
}) {
  return (
    <PageBand
      title="Tenants"
      description="Invite a company, then follow it from signup to a live Calendly connection."
      actions={
        // On a phone it wraps under the line, so the line keeps the band's width.
        <div className="flex @max-md:basis-full">
          <Button onClick={onCreate} className="h-[34px] rounded-[7px] px-3.5 text-[13px] font-semibold">
            <PlusIcon data-icon="inline-start" aria-hidden="true" />
            New tenant invite
          </Button>
        </div>
      }
    >
      <div className="-mx-4 flex flex-wrap items-center gap-x-4 border-t border-board-line px-4 @lg:-mx-[18px] @lg:px-[18px]">
        <StatusTabs status={status} onSelect={onStatus} />
        {/* On a phone the tabs take the row; the count would need a line of its own. */}
        <p aria-live="polite" className="ml-auto hidden py-2 text-[13px] text-board-muted tabular-nums empty:hidden @md:block">
          {summary}
        </p>
      </div>
    </PageBand>
  );
}

/** ALL, then each status; arrows move between them. They scroll sideways on a phone. */
function StatusTabs({
  status,
  onSelect,
}: {
  status: TenantStatus | undefined;
  onSelect: (status: TenantStatus | undefined) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  const select = (index: number) => {
    const next = STATUS_TABS[(index + STATUS_TABS.length) % STATUS_TABS.length];
    onSelect(next);
    const tab = listRef.current?.querySelector<HTMLButtonElement>(`#${statusTabId(next)}`);
    tab?.focus();
    tab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = STATUS_TABS.indexOf(status);
    if (event.key === "ArrowRight") select(current + 1);
    else if (event.key === "ArrowLeft") select(current - 1);
    else if (event.key === "Home") select(0);
    else if (event.key === "End") select(STATUS_TABS.length - 1);
    else return;
    event.preventDefault();
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="Tenant status"
      onKeyDown={onKeyDown}
      className="flex max-w-full min-w-0 items-center gap-[18px] overflow-x-auto [scrollbar-width:none] @xl:gap-[22px]"
    >
      {STATUS_TABS.map((tab) => {
        const selected = tab === status;
        return (
          <button
            key={tab ?? "all"}
            id={statusTabId(tab)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={TENANTS_PANEL_ID}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(tab)}
            className={cn(
              "flex h-10 shrink-0 items-center border-b-2 font-condensed text-[13px] font-semibold tracking-[0.12em] whitespace-nowrap uppercase outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              selected ? "border-primary text-board-foreground" : "border-transparent text-board-muted hover:text-board-foreground",
            )}
          >
            {tab ? TENANT_STATUS_LABEL[tab] : "All"}
          </button>
        );
      })}
    </div>
  );
}
