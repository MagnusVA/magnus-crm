import Link from "next/link";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import {
  meetingStatusConfig,
  type MeetingStatus,
} from "./status-config";

type MeetingBlockProps = {
  meetingId: string;
  scheduledAt: number;
  durationMinutes: number;
  status: string;
  leadName: string;
  eventTypeName?: string | null;
  className?: string;
  style?: React.CSSProperties;
};

/**
 * A single meeting block rendered inside the calendar grid.
 *
 * Positioned absolutely by the parent view — the `style` prop supplies `top`
 * and `height` calculated from the meeting time.  A coloured left‑border
 * communicates status at a glance.
 *
 * Clicking navigates to the meeting detail page (Phase 6).
 */
export function MeetingBlock({
  meetingId,
  scheduledAt,
  durationMinutes,
  status,
  leadName,
  eventTypeName,
  className,
  style,
}: MeetingBlockProps) {
  const config =
    meetingStatusConfig[status as MeetingStatus] ??
    meetingStatusConfig.scheduled;

  const startTime = format(scheduledAt, "h:mm a");
  const endTimestamp = scheduledAt + durationMinutes * 60 * 1000;
  const endTime = format(endTimestamp, "h:mm a");

  // Short blocks (< 30 min → < ~30px) get a condensed layout
  const isShort = durationMinutes < 30;

  return (
    <Link
      href={`/workspace/closer/meetings/${meetingId}`}
      className={cn(
        "absolute inset-x-1 overflow-hidden rounded-md border-l-[3px] px-2 py-1 text-xs transition-opacity hover:opacity-80",
        config.blockClass,
        className,
      )}
      style={style}
      aria-label={`${leadName}, ${startTime} – ${endTime}, ${config.label}`}
    >
      {isShort ? (
        <span className={cn("truncate font-medium", config.textClass)}>
          {leadName} · {startTime}
        </span>
      ) : (
        <>
          <p className={cn("truncate font-medium", config.textClass)}>
            {leadName}
          </p>
          <p className="truncate text-muted-foreground">
            {startTime} – {endTime}
            {eventTypeName ? ` · ${eventTypeName}` : ""}
          </p>
        </>
      )}
    </Link>
  );
}
