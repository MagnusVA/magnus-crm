"use client";

import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { FilmIcon, ImageIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { DetailCard } from "@/app/workspace/closer/meetings/_components/detail-card";
import { formatBusinessDateSpan } from "./date-range-picker";
import type { TopOriginsSection } from "./overview-dashboard-types";
import { formatOriginValue, formatWholeNumber } from "./overview-formatters";
import { OverviewSectionState } from "./overview-section-state";

// Overview's top posts and reels by lead-gen submissions. Each post shows
// its stored Instagram preview (thumbnail, caption, handle, date) when one
// was fetched; otherwise the readable link stands in for the caption.

type OriginRow = Extract<TopOriginsSection, { status: "ready" }>["data"]["rows"][number];
/** A ranked post; Lead Gen's per-team rows carry the source as a plain string. */
type PostRowData = Omit<OriginRow, "source"> & { source: string };
type Preview = FunctionReturnType<typeof api.leadGen.originPreviews.listOriginPreviews>[number];

const kindWord: Record<string, string> = { post: "Post", reel: "Reel", story: "Story", story_poll: "Story poll" };

// The year shows only outside the business day's year. Without today's
// business date, the year always shows.
function postedDay(isoDate: string, todayBusinessDate: string | undefined) {
  if (Number.isNaN(Date.parse(`${isoDate}T00:00:00Z`))) return null;
  return formatBusinessDateSpan(isoDate, isoDate, todayBusinessDate ?? "");
}

function isExternalUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function hostOf(value: string) {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function Thumbnail({ preview, kind }: { preview: Preview | undefined; kind: string }) {
  if (preview?.thumbnailUrl) {
    return (
      // Convex storage URLs; next/image would need every deployment's host configured.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={preview.thumbnailUrl}
        alt=""
        loading="lazy"
        className="size-11 shrink-0 rounded-[7px] bg-muted object-cover"
      />
    );
  }
  const Icon = kind === "reel" ? FilmIcon : ImageIcon;
  return (
    <span aria-hidden="true" className="grid size-11 shrink-0 place-items-center rounded-[7px] bg-muted text-muted-foreground">
      <Icon className="size-[18px]" />
    </span>
  );
}

function PostRow({
  row,
  preview,
  todayBusinessDate,
}: {
  row: PostRowData;
  preview: Preview | undefined;
  todayBusinessDate: string | undefined;
}) {
  const ready = preview?.status === "ready";
  const caption = ready ? preview.caption : null;
  const title = caption || formatOriginValue(row.originValue);
  const kind = kindWord[row.originKind] ?? row.originKind;
  const meta = [
    ready && preview.handle ? `@${preview.handle}` : hostOf(row.originValue),
    kind,
    ready && preview.postedOn ? postedDay(preview.postedOn, todayBusinessDate) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const external = isExternalUrl(row.originValue);

  return (
    <li className="relative flex items-center gap-3 border-b px-4 py-2 last:border-b-0 hover:bg-muted/60">
      <Thumbnail preview={ready ? preview : undefined} kind={row.originKind} />
      <div className="min-w-0 flex-1">
        {external ? (
          <a
            href={row.originValue}
            target="_blank"
            rel="noreferrer"
            title={row.originValue}
            className="block truncate font-semibold outline-none after:absolute after:inset-0 after:rounded-[inherit] focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
          >
            {title}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        ) : (
          <p className="truncate font-semibold">{title}</p>
        )}
        <p className="truncate text-[13px] text-muted-foreground">{meta}</p>
      </div>
      <div className="shrink-0 text-right">
        <p className="font-condensed text-xl leading-none font-semibold tabular-nums">
          {formatWholeNumber(row.submissions)}
          <span className="sr-only"> submissions</span>
        </p>
        <p className="mt-1 text-[13px] text-muted-foreground">
          {formatWholeNumber(row.uniqueProspects)} {row.uniqueProspects === 1 ? "person" : "people"}
        </p>
      </div>
    </li>
  );
}

/** The ranked post rows with their previews; Lead Gen reuses them per team. */
export function TopPostsList({
  rows,
  todayBusinessDate,
  label = "Top posts and reels by submissions",
}: {
  rows: PostRowData[];
  todayBusinessDate: string | undefined;
  label?: string;
}) {
  const keys = rows.map((row) => row.originKey).slice(0, 50);
  const previews = useQuery(api.leadGen.originPreviews.listOriginPreviews, { originKeys: keys });
  const byKey = new Map((previews ?? []).map((preview) => [preview.originKey, preview]));
  return (
    <ol aria-label={label} className="flex flex-col">
      {rows.map((row) => (
        <PostRow key={`${row.source}:${row.originKey}`} row={row} preview={byKey.get(row.originKey)} todayBusinessDate={todayBusinessDate} />
      ))}
    </ol>
  );
}

export function TopOriginsOverviewSection({
  section,
  rangePhrase = "in this range",
  todayBusinessDate,
}: {
  section: TopOriginsSection;
  /** How the empty line names the range: "today", "this week", "in this range". */
  rangePhrase?: string;
  /** Today's business date, to drop this year from post dates. */
  todayBusinessDate?: string;
}) {
  return (
    <DetailCard title="Top posts & reels" meta="By submissions" className="min-w-0">
      {section.status === "ready" ? (
        <TopPostsList rows={section.data.rows} todayBusinessDate={todayBusinessDate} />
      ) : (
        <OverviewSectionState section={section} emptyTitle={`No submissions came from a post or reel ${rangePhrase}.`} />
      )}
    </DetailCard>
  );
}
