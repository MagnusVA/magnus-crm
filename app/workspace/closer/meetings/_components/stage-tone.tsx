import { dealPositionLabel } from "@/convex/opportunities/stageLabels";
import type { DealPosition, SystemLossReason } from "@/convex/opportunities/stages";
import { cn } from "@/lib/utils";

/** The stage colour scale (app/globals.css), spelled out so Tailwind sees each class. */
export const STAGE_TONE: Record<
  DealPosition,
  { chip: string; fill: string; ring: string; line: string }
> = {
  qualified: {
    chip: "bg-stage-held/15 text-stage-held-ink",
    fill: "bg-stage-held border-stage-held",
    ring: "border-stage-held",
    line: "before:bg-stage-held",
  },
  booked: {
    chip: "bg-stage-booked/15 text-stage-booked-ink",
    fill: "bg-stage-booked border-stage-booked",
    ring: "border-stage-booked",
    line: "before:bg-stage-booked",
  },
  call_held: {
    chip: "bg-stage-held/15 text-stage-held-ink",
    fill: "bg-stage-held border-stage-held",
    ring: "border-stage-held",
    line: "before:bg-stage-held",
  },
  follow_up: {
    chip: "bg-stage-follow-up/15 text-stage-follow-up-ink",
    fill: "bg-stage-follow-up border-stage-follow-up",
    ring: "border-stage-follow-up",
    line: "before:bg-stage-follow-up",
  },
  won: {
    chip: "bg-stage-won/15 text-stage-won-ink",
    fill: "bg-stage-won border-stage-won",
    ring: "border-stage-won",
    line: "before:bg-stage-won",
  },
  lost: {
    chip: "bg-stage-lost/12 text-stage-lost-ink",
    fill: "bg-stage-lost border-stage-lost",
    ring: "border-stage-lost",
    line: "before:bg-stage-lost",
  },
};

/** The deal's stage as a condensed chip: "Booked", "Won", "Lost: no-show". */
export function StageChip({
  position,
  systemLoss,
  className,
}: {
  position: DealPosition;
  systemLoss?: SystemLossReason | null;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded px-1.5 font-condensed text-[0.6875rem] font-bold tracking-[0.1em] whitespace-nowrap uppercase",
        STAGE_TONE[position].chip,
        className,
      )}
    >
      {dealPositionLabel(position, systemLoss)}
    </span>
  );
}
