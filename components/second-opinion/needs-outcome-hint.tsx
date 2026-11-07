"use client";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { confidenceOf } from "@/convex/secondOpinion/verdict";
import { labels } from "./presentation";
export function SecondOpinionHint({
  meetingId,
}: {
  meetingId: Id<"meetings">;
}) {
  const detail = useQuery(api.secondOpinion.forMeeting, { meetingId });
  const answers = detail?.opinion.answers;
  if (detail?.opinion.verdict !== "hint" || !answers) return null;
  return (
    <p className="text-xs text-muted-foreground">
      Second opinion · {labels[answers.attendance.choice].toLowerCase()}, ended
      in {labels[answers.ending.choice].toLowerCase()} ·{" "}
      {Math.round(confidenceOf(answers.ending) * 100)}%
    </p>
  );
}
