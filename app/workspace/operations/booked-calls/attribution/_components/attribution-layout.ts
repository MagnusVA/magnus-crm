// Shared by the page and its skeleton (a server component), so it stays out
// of the "use client" module.

/** The page root: the container every section folds by (same as Booked calls). */
export const ATTRIBUTION_ROOT =
  "@container mx-auto flex w-full max-w-[1500px] min-w-0 flex-col gap-3.5 pb-6 short:gap-3";
export const ATTRIBUTION_TITLE = "Attribution";
export const ATTRIBUTION_DESCRIPTION = "DM teams, DM closers, the link portal and the checks behind booked calls.";
export const ATTRIBUTION_BACK = { href: "/workspace/operations/booked-calls", label: "Booked Calls" };

/** The edge-to-edge board-line rule above the in-band tabs, cancelling the band's side padding. */
export const BAND_TAB_ROW = "-mx-4 border-t border-board-line px-4 @lg:-mx-[18px] @lg:px-[18px]";
export const BAND_TAB_LIST = "flex min-w-0 gap-4 overflow-x-auto [scrollbar-width:none] @xl:gap-[22px]";

export const SECTIONS = ["teams", "portal", "diagnostics"] as const;
export type Section = (typeof SECTIONS)[number];

export const SECTION_LABEL: Record<Section, string> = {
  teams: "Teams & DM closers",
  portal: "Link portal",
  diagnostics: "Diagnostics",
};
