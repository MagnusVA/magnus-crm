"use client";

// A client component: teamHref comes from a client module, so the server
// skeleton can't call it directly.
import { ArrowUpRightIcon } from "lucide-react";
import { MovedToTeamChip, TipLink, teamHref } from "../../_components/team-links";

/** A plain link on the band: board text, underlined on hover. */
const boardLink =
  "inline-flex h-7 items-center gap-0.5 px-1 text-[13px] text-board-muted hover:text-board-foreground hover:underline underline-offset-[3px] focus-visible:ring-offset-board";

/**
 * The band's lower row: Coverage, and where schedules, goals and teams moved.
 * The page and its loading skeleton both render it, so the band is the same
 * height before and after the data arrives.
 */
export function BookedCallsBandLinks() {
  return (
    <div className="-mx-4 flex flex-wrap items-center justify-end gap-2 border-t border-board-line px-4 py-1.5 @lg:-mx-[18px] @lg:px-[18px]">
      <TipLink
        href="/workspace/booking"
        tip="Booking setup › Coverage: which links and event types each team's DM closers get."
        className={boardLink}
      >
        Coverage
        <ArrowUpRightIcon aria-hidden="true" className="size-3.5" />
      </TipLink>
      <MovedToTeamChip
        href={teamHref.teams()}
        moved={["Schedules", "Edit goals", "DM teams & links"]}
        tip="DM teams, their closers' weeks and their goals now live in Team. Change them there; this page follows."
      />
    </div>
  );
}
