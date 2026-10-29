import type { OpportunityStatus } from "../opportunities/stages";
import type { DealPosition } from "../opportunities/stages";

// The closer pipeline's tabs (docs/plans/phase-5-deal-status.md §6.2): All,
// then the positions a closer's deals reach, in order. Closers own no
// Qualified deals, so Qualified has no tab. The missed meetings' deals are
// under Lost (Q1).

export const CLOSER_PIPELINE_TABS = [
  "booked",
  "call_held",
  "follow_up",
  "won",
  "lost",
] as const satisfies readonly DealPosition[];

export type CloserPipelineTab = (typeof CLOSER_PIPELINE_TABS)[number];

// The tab an old `status=` link opens: the position its deals are on now.
// A scheduled side deal is at Call held, but the link opens Booked, where
// the closer's scheduled deals are.
const TAB_OF_STATUS: Record<OpportunityStatus, CloserPipelineTab | null> = {
  qualified_pending: null,
  scheduled: "booked",
  follow_up_scheduled: "follow_up",
  reschedule_link_sent: "follow_up",
  payment_received: "won",
  lost: "lost",
  canceled: "lost",
  no_show: "lost",
};

function isCloserPipelineTab(value: string): value is CloserPipelineTab {
  return (CLOSER_PIPELINE_TABS as readonly string[]).includes(value);
}

/**
 * The tab a pipeline URL opens, or null for All: `stage=` when the URL has
 * it, else an old `status=` link. Anything else, Qualified included, opens
 * All.
 */
export function closerPipelineTabFromSearch(search: {
  get(name: string): string | null;
}): CloserPipelineTab | null {
  const stage = search.get("stage");
  if (stage !== null) {
    return isCloserPipelineTab(stage) ? stage : null;
  }
  const status = search.get("status");
  if (status !== null && Object.hasOwn(TAB_OF_STATUS, status)) {
    return TAB_OF_STATUS[status as OpportunityStatus];
  }
  return null;
}

// My Pipeline's lookup tabs: every deal, or the deals by outcome.
export const CLOSER_LOOKUP_TABS = ["all", "open", "won", "lost"] as const;

export type CloserLookupTab = (typeof CLOSER_LOOKUP_TABS)[number];

function isCloserLookupTab(value: string): value is CloserLookupTab {
  return (CLOSER_LOOKUP_TABS as readonly string[]).includes(value);
}

/**
 * The lookup tab a pipeline URL opens: `tab=` when it names one, else the
 * tab an older `stage=` or `status=` link's deals are on. Booked, Call held
 * and Follow-up deals are open; anything else opens All.
 */
export function closerLookupTabFromSearch(search: {
  get(name: string): string | null;
}): CloserLookupTab {
  const tab = search.get("tab");
  if (tab !== null && isCloserLookupTab(tab)) {
    return tab;
  }
  const position = closerPipelineTabFromSearch(search);
  if (position === null) return "all";
  return position === "won" || position === "lost" ? position : "open";
}
