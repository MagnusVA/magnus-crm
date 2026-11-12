import type { ReactNode, Ref } from "react";
import { PageBand } from "@/app/workspace/_components/page-band";

// The page's band, shared by the page and its skeleton: the title, one line on
// what the page holds, and the tab row under a board-line rule (the Settings
// band's tab grammar).

export const CALL_INSIGHTS_TABS = [
  { value: "calls", label: "Calls" },
  { value: "suggestions", label: "Suggestions" },
  { value: "reports", label: "Reports" },
  { value: "quality", label: "Quality" },
  { value: "settings", label: "Settings" },
] as const;

export type CallInsightsTab = (typeof CALL_INSIGHTS_TABS)[number]["value"];

export const CALL_INSIGHTS_HREF = "/workspace/pipeline/call-insights";

export function tabFromParam(value: string | null): CallInsightsTab {
  return CALL_INSIGHTS_TABS.some((tab) => tab.value === value)
    ? (value as CallInsightsTab)
    : "calls";
}

/**
 * `navRef` reaches the tab row, so the page can scroll the open tab into view:
 * the row scrolls sideways on a phone.
 */
export function CallInsightsBand({
  tabs,
  navRef,
}: {
  tabs: ReactNode;
  navRef?: Ref<HTMLElement>;
}) {
  return (
    <PageBand
      title="Call insights"
      description="What prospects said on recorded calls, the results suggested from them, and what reading them costs."
    >
      <nav
        ref={navRef}
        aria-label="Call insights sections"
        className="-mx-4 flex scroll-px-4 items-center gap-[22px] overflow-x-auto border-t border-board-line px-4 [scrollbar-width:none] @lg:-mx-[18px] @lg:scroll-px-[18px] @lg:px-[18px]"
      >
        {tabs}
      </nav>
    </PageBand>
  );
}
