import type { OpinionDetail } from "./presentation";
import { cn } from "@/lib/utils";
import { localTime } from "./presentation";

export function OpinionEvidence({ detail }: { detail: OpinionDetail }) {
  const evidence = detail.opinion.evidence;
  if (!evidence) return null;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">
        {evidence.recordedMinutes} minutes recorded · {detail.closer} spoke for{" "}
        {evidence.closerMinutes} · {detail.person} for{" "}
        {evidence.prospectMinutes}
        {evidence.prospectFirstAt !== undefined &&
          `, first at ${localTime(evidence.prospectFirstAt, detail.timeZone)}`}
      </p>
      {evidence.talkPattern && (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium">Who spoke, minute by minute</p>
          <div
            role="img"
            aria-label={`Minute-by-minute talk: ${[...evidence.talkPattern].map((role, minute) => `${minute + 1}: ${role === "c" ? "closer" : role === "p" ? "prospect" : "silence"}`).join(", ")}`}
            className="flex h-7 gap-0.5 overflow-hidden rounded-sm"
          >
            {[...evidence.talkPattern].map((role, minute) => (
              <span
                key={minute}
                title={`Minute ${minute + 1}: ${role === "c" ? detail.closer : role === "p" ? detail.person : "Silence"}`}
                className={cn(
                  "min-w-0 flex-1",
                  role === "c"
                    ? "bg-chart-1"
                    : role === "p"
                      ? "bg-chart-2"
                      : "bg-muted",
                )}
              />
            ))}
          </div>
          <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-sm bg-chart-1" />
              Closer
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-sm bg-chart-2" />
              Prospect
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-sm bg-muted" />
              Silence
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
