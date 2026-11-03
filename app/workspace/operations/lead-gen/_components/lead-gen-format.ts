import { cn } from "@/lib/utils";

// Figures and column heads shared by the Lead Gen sections.

const wholeNumber = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const perHour = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const hours = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const share = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 });

export function formatCount(value: number) {
  return wholeNumber.format(value);
}

/** Submissions per scheduled hour, two decimals as the page has always shown. */
export function formatPerHour(value: number) {
  return perHour.format(value);
}

export function formatHours(value: number) {
  return hours.format(value);
}

/** "40%", "12.5%": one decimal at most, as the page has always shown. */
export function formatShare(value: number) {
  return share.format(value);
}

export function perHourRate(submissions: number, scheduledHours: number) {
  return scheduledHours > 0 ? submissions / scheduledHours : null;
}

export function plural(value: number, one: string, many = `${one}s`) {
  return `${formatCount(value)} ${value === 1 ? one : many}`;
}

/** 15px condensed tabular figure, the tables' number style. */
export const figureClass = "font-condensed text-[15px] font-semibold tabular-nums";

/** Column heads: 11px condensed label, bottom-aligned, right over figures. */
export function headClass(align: "left" | "right" = "right") {
  return cn(
    "min-h-7 px-2.5 pt-2 pb-1.5 align-bottom font-condensed text-[11px] leading-tight font-semibold tracking-[0.14em] text-muted-foreground uppercase",
    align === "right" ? "text-right" : "pl-4 text-left",
  );
}

/** The dim a section takes while it keeps its last data on screen. */
export function reloadingClass(reloading: boolean) {
  return cn("transition-opacity duration-200 motion-reduce:transition-none", reloading && "opacity-60");
}
