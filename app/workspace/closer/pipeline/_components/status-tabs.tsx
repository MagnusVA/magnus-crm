"use client";

import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  PIPELINE_DISPLAY_ORDER,
  opportunityStatusConfig,
  type OpportunityStatus,
} from "../../_components/status-config";

type StatusTabsProps = {
  activeStatus: OpportunityStatus | undefined;
  /** Counts per status — used to render count badges in each tab. */
  counts: Record<string, number>;
  total: number;
  onStatusChange: (status: OpportunityStatus | undefined) => void;
};

/**
 * Filter tabs for the closer pipeline page.
 *
 * "All" shows every opportunity; status‑specific tabs show only that status.
 * Each tab renders a count badge so the closer can see distribution at a
 * glance.
 *
 * Uses shadcn Tabs with `variant="line"` for a clean filter‑bar aesthetic.
 * Tab state is lifted — the parent page controls `activeStatus`.
 */
export function StatusTabs({
  activeStatus,
  counts,
  total,
  onStatusChange,
}: StatusTabsProps) {
  return (
    <Tabs
      value={activeStatus ?? "all"}
      onValueChange={(v) =>
        onStatusChange(v === "all" ? undefined : (v as OpportunityStatus))
      }
    >
      <TabsList variant="line" className="w-full flex-wrap justify-start">
        <TabsTrigger value="all">
          All
          <Badge variant="secondary" className="ml-1">
            {total}
          </Badge>
        </TabsTrigger>

        {PIPELINE_DISPLAY_ORDER.map((status) => {
          const config = opportunityStatusConfig[status];
          const count = counts[status] ?? 0;
          return (
            <TabsTrigger key={status} value={status}>
              {config.label}
              <Badge variant="secondary" className="ml-1">
                {count}
              </Badge>
            </TabsTrigger>
          );
        })}
      </TabsList>
    </Tabs>
  );
}
