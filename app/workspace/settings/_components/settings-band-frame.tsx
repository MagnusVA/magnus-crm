import type { ReactNode } from "react";
import Link from "next/link";
import { PageBand } from "@/app/workspace/_components/page-band";

// The Settings band's frame, shared by the page and its skeleton: the title,
// what the page holds and where the rest went, and the tab row under a
// board-line rule (the Team band's tab grammar).

export const SETTINGS_TABS = [
  { value: "integrations", label: "Integrations" },
  { value: "business-day", label: "Business day" },
  { value: "lead-gen", label: "Lead gen" },
  { value: "respark", label: "Respark" },
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number]["value"];

/** One tab: 40px, condensed caps, the active one over a 2px lime underline. */
export const TAB_CLASS =
  "flex h-10 shrink-0 items-center gap-[7px] border-b-2 border-transparent font-condensed text-[13px] font-semibold tracking-[0.12em] whitespace-nowrap text-board-muted uppercase outline-none hover:text-board-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-[current=page]:border-primary aria-[current=page]:text-board-foreground";

const BOARD_LINK =
  "rounded-[2px] text-board-foreground underline decoration-board-foreground/40 underline-offset-[3px] outline-none hover:decoration-board-foreground focus-visible:ring-2 focus-visible:ring-ring";

export function SettingsBandFrame({ showRespark, tabs }: { showRespark: boolean; tabs: ReactNode }) {
  return (
    <PageBand
      title="Settings"
      description={
        <>
          {showRespark
            ? "Integrations, the business day, lead gen capture and Respark."
            : "Integrations, the business day and lead gen capture."}
          <span className="mt-0.5 block">
            Event types and programs are in{" "}
            <Link href="/workspace/booking" className={BOARD_LINK}>
              Booking setup
            </Link>
            ; members, teams, schedules and goals are in{" "}
            <Link href="/workspace/team" className={BOARD_LINK}>
              Team
            </Link>
            .
          </span>
        </>
      }
    >
      <nav
        aria-label="Settings sections"
        className="-mx-4 flex items-center gap-[22px] overflow-x-auto border-t border-board-line px-4 [scrollbar-width:none] @lg:-mx-[18px] @lg:px-[18px]"
      >
        {tabs}
      </nav>
    </PageBand>
  );
}
