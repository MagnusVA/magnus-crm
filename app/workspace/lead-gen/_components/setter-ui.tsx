import type { ReactNode } from "react";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import { HelpTip } from "@/app/workspace/team/_components/team-ui";
import { instagramProfileUrl } from "@/lib/respark/display";
import { cn } from "@/lib/utils";
import { detectInstagramOriginUrl } from "./instagram-origin-detection";

// Pieces shared by the setter's Capture and My activity pages and their
// skeletons (DESIGN.md, Layout: Capture and My activity). No hooks here, so
// loading.tsx can draw the same frame.

export type ActivityRow = FunctionReturnType<typeof api.leadGen.activity.listMyRecentSubmissions>["page"][number];

/** Capture: a 640px measure, the page root the container. */
export const CAPTURE_ROOT = "@container mx-auto flex w-full max-w-[640px] min-w-0 flex-col gap-3.5 pb-6 short:gap-3";

/** My activity: an 1100px measure, the page root the container. */
export const ACTIVITY_ROOT = "@container mx-auto flex w-full max-w-[1100px] min-w-0 flex-col gap-3.5 pb-6 short:gap-3";

/** One condensed status word; the caller adds its ink. */
export const STATUS_WORD = "font-condensed text-[13px] leading-[1.1] font-bold tracking-[0.08em] whitespace-nowrap uppercase";

/** A time in a row: condensed, tabular. */
export const ROW_TIME = "font-condensed text-[15px] leading-none font-semibold tabular-nums whitespace-nowrap";

const BAND_LABEL = "font-condensed text-[11px] leading-none font-semibold tracking-[0.14em] whitespace-nowrap text-board-muted uppercase";

/**
 * The band's figures: zones in one ruled grid (1px board-line gaps) under a
 * board-line rule that runs edge to edge. The caller sets the columns and
 * the band's negative margins.
 */
export function BandZones({
  label,
  busy = false,
  className,
  children,
}: {
  label: string;
  busy?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <dl
      aria-label={label}
      aria-busy={busy}
      className={cn(
        "grid gap-px border-t border-board-line bg-board-line transition-opacity duration-200 motion-reduce:transition-none",
        busy && "opacity-60",
        className,
      )}
    >
      {children}
    </dl>
  );
}

/** One zone: an 11px condensed label (with its explanation on hover) over a 26px figure. */
export function BandZone({
  label,
  tip,
  className,
  children,
}: {
  label: string;
  tip?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5 bg-board px-4 py-2.5 @lg:px-[18px]", className)}>
      <dt className={BAND_LABEL}>{tip ? <HelpTip tip={tip}>{label}</HelpTip> : label}</dt>
      <dd className="font-condensed text-[26px] leading-none font-semibold tabular-nums">{children}</dd>
    </div>
  );
}

/** A zone's figure before it arrives: a pulsing bar at the figure's height. */
export function ZonePending() {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-[26px] w-12 animate-pulse rounded-md bg-board-foreground/10 align-top motion-reduce:animate-none"
    />
  );
}

/** The @handle, linked to the Instagram profile in a new tab; "No handle" in slate without one. */
export function ProspectHandle({ handle, className }: { handle: string | undefined; className?: string }) {
  const url = instagramProfileUrl(handle ?? null);
  if (!handle || !url) return <span className={cn("text-muted-foreground", className)}>No handle</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      title={`Open @${handle} on Instagram`}
      translate="no"
      className={cn(
        "relative z-10 block truncate rounded-sm font-medium underline-offset-[3px] outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      @{handle}
    </a>
  );
}

const ORIGIN_NAMES: Record<string, string> = {
  story_poll: "Story poll",
  story: "Story",
  follower: "Follower",
  application: "Application",
  post: "Post",
  reel: "Reel",
};

/** "story_poll" -> "Story poll"; unknown kinds read as words. */
export function originName(kind: string) {
  return ORIGIN_NAMES[kind] ?? kind.replace(/_/g, " ").replace(/^./, (first) => first.toUpperCase());
}

/**
 * A row's origin in words: "Reel · C9x2AbQ" (with the post's URL), "Story
 * poll", a respark's bucket, or for Meta Business a dash (or the source,
 * where the row has no source column).
 */
export function originWords(
  row: Pick<ActivityRow, "source" | "originKind" | "originValue">,
): { text: string; href?: string; empty?: boolean } {
  if (row.source === "respark") {
    const bucket = row.originValue ?? "Respark";
    return { text: bucket };
  }
  if (row.originKind === "source_only") {
    return { text: "—", empty: true };
  }
  if ((row.originKind === "post" || row.originKind === "reel") && row.originValue) {
    const detected = detectInstagramOriginUrl(row.originValue);
    return detected
      ? { text: `${originName(detected.originKind)} · ${detected.shortcode}`, href: detected.originUrl }
      : { text: row.originValue, href: row.originValue };
  }
  return { text: row.originValue ?? originName(row.originKind) };
}

/** What a row was: CAPTURE and RESPARKED in ink, NOT A FIT in slate. */
export function whatWord(type: ActivityRow["type"]) {
  if (type === "Respark · not a fit") return { word: "Not a fit", ink: "text-muted-foreground" };
  if (type === "Respark · resparked") return { word: "Resparked", ink: "text-foreground" };
  return { word: "Capture", ink: "text-foreground" };
}

export function sourceName(source: ActivityRow["source"]) {
  if (source === "respark") return "Respark";
  return source === "meta_business" ? "Meta Business" : "Instagram";
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string, withDay: boolean) {
  const key = `${timeZone}|${withDay}`;
  let format = formatters.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
      ...(withDay ? { month: "short", day: "numeric" } : {}),
    });
    formatters.set(key, format);
  }
  return format;
}

/** "3:35 PM" in the business day's time zone. */
export function timeOfDay(timestamp: number, timeZone: string) {
  return formatter(timeZone, false).format(timestamp);
}

/** "Nov 5 · 11:15 AM" in the business day's time zone. */
export function dayAndTime(timestamp: number, timeZone: string) {
  const parts = formatter(timeZone, true).formatToParts(timestamp);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("month")} ${part("day")} · ${part("hour")}:${part("minute")} ${part("dayPeriod")}`;
}
