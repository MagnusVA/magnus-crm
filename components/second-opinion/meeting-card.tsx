"use client";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { confidenceOf } from "@/convex/secondOpinion/verdict";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { OpinionEvidence } from "./evidence";
import { CloserOpinionNote } from "./closer-note";
import {
  labels,
  recordLabel,
  localTime,
  type OpinionDetail,
} from "./presentation";

export function OpinionChip({ detail }: { detail: OpinionDetail }) {
  const status =
    detail.opinion.status !== "answered"
      ? detail.opinion.status
      : detail.opinion.reviewState === "checked"
        ? "checked"
        : (detail.opinion.verdict ?? "unsure");
  return (
    <Badge
      variant={
        status === "disagrees"
          ? "destructive"
          : status === "agrees"
            ? "secondary"
            : "outline"
      }
    >
      {labels[status]}
    </Badge>
  );
}
export function OpinionAnswers({ detail }: { detail: OpinionDetail }) {
  const { answers } = detail.opinion;
  if (!answers) return null;
  const rows = [
    {
      label: "Attendance",
      value: labels[answers.attendance.choice],
      confidence: confidenceOf(answers.attendance),
    },
    {
      label: "How it ended",
      value: labels[answers.ending.choice],
      confidence: confidenceOf(answers.ending),
    },
    {
      label: "Main objection",
      value: labels[answers.objection.choice],
      confidence: confidenceOf(answers.objection),
    },
    {
      label: "Your record",
      value: recordLabel(detail.opinion.record),
      confidence: answers.claim,
    },
  ];
  return (
    <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className="flex justify-between gap-3">
            <span>{row.value}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {row.confidence === undefined
                ? "—"
                : `${Math.round(row.confidence * 100)}%`}
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
}
export function OpinionReviewFooter({ detail }: { detail: OpinionDetail }) {
  const review = detail.opinion.review;
  return (
    <p className="text-xs text-muted-foreground">
      {review
        ? `Checked by ${detail.reviewer ?? "an admin"} at ${localTime(review.at, detail.timeZone)} · ${review.outcome === "second_opinion_right" ? "the second opinion was right" : "the closer's record stands"}`
        : "From the recording. It never changes your record."}
    </p>
  );
}
export function SecondOpinionCard({
  meetingId,
}: {
  meetingId: Id<"meetings">;
}) {
  const detail = useQuery(api.secondOpinion.forMeeting, { meetingId });
  if (!detail) return null;
  const { opinion } = detail;
  const evidence = opinion.evidence;
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Second opinion</CardTitle>
          <OpinionChip detail={detail} />
        </div>
        <CardDescription>
          Jev
          {opinion.answeredAt &&
            ` · ${localTime(opinion.answeredAt, detail.timeZone)}`}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {opinion.verdict === "disagrees" && (
          <Alert>
            <AlertDescription>
              {opinion.record?.kind === "no_show" && evidence
                ? `You recorded a no-show. ${detail.person} speaks for ${evidence.prospectMinutes} of the recording's ${evidence.recordedMinutes} minutes${evidence.prospectFirstAt !== undefined ? `, from ${localTime(evidence.prospectFirstAt, detail.timeZone)}` : ""}.`
                : `The recording disagrees with the recorded ${recordLabel(opinion.record).toLowerCase()}. An admin can check it.`}
            </AlertDescription>
          </Alert>
        )}
        <OpinionAnswers detail={detail} />
        {opinion.verdict === "disagrees" && <OpinionEvidence detail={detail} />}
        {opinion.closerNote && (
          <div className="flex flex-col gap-1 text-sm">
            <p className="whitespace-pre-wrap">{opinion.closerNote}</p>
            <p className="text-xs text-muted-foreground">
              Sent to admins
              {opinion.closerNoteAt &&
                ` · ${localTime(opinion.closerNoteAt, detail.timeZone)}`}
            </p>
          </div>
        )}
        {detail.canAddNote && (
          <CloserOpinionNote secondOpinionId={opinion._id} />
        )}
      </CardContent>
      <CardFooter className="flex flex-wrap justify-between gap-3">
        <OpinionReviewFooter detail={detail} />
        <div className="flex gap-2">
          {detail.recordingUrl && (
            <Button asChild variant="link" size="sm">
              <a href={detail.recordingUrl} target="_blank" rel="noreferrer">
                Listen
              </a>
            </Button>
          )}
          {detail.canReview && (
            <Button asChild variant="link" size="sm">
              <Link href={`/workspace/pipeline/second-opinions/${opinion._id}`}>
                Review
              </Link>
            </Button>
          )}
        </div>
      </CardFooter>
    </Card>
  );
}
