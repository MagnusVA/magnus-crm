"use client";
import { useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Button } from "@/components/ui/button";
import {
  OpinionChip,
  OpinionAnswers,
  OpinionReviewFooter,
} from "@/components/second-opinion/meeting-card";
import { OpinionEvidence } from "@/components/second-opinion/evidence";
import { RecordingSummary } from "@/components/fathom/recording-summary";
import {
  failureLabels,
  heardLabel,
  localDate,
  recordLabel,
} from "@/components/second-opinion/presentation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { usePageTitle } from "@/hooks/use-page-title";
import { useBreadcrumbTrail } from "@/hooks/use-breadcrumbs";
import { getErrorMessage } from "@/lib/errors";
import { SecondOpinionsSkeleton } from "./second-opinions-skeleton";
const ReopenDialog = dynamic(
  () => import("@/components/second-opinion/reopen-dialog"),
);
const readingNames: Record<string, string> = {
  attendance: "attendance",
  ending: "how it ended",
  objection: "the objection",
  claim: "the closer's record",
};
export function SecondOpinionDetailPageClient({
  secondOpinionId,
}: {
  secondOpinionId: Id<"secondOpinions">;
}) {
  usePageTitle("Second opinion");
  useBreadcrumbTrail([
    { label: "Second opinions", href: "/workspace/pipeline/second-opinions" },
    {
      label: "Review",
      href: `/workspace/pipeline/second-opinions/${secondOpinionId}`,
    },
  ]);
  const detail = useQuery(api.secondOpinion.getForReview, { secondOpinionId });
  const check = useMutation(api.secondOpinion.check);
  const rerun = useMutation(api.secondOpinion.rerun);
  const router = useRouter();
  const [dialog, setDialog] = useState(false);
  const [busy, setBusy] = useState(false);
  if (detail === undefined) return <SecondOpinionsSkeleton />;
  if (!detail)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>This check is unavailable.</EmptyTitle>
        </EmptyHeader>
        <Button asChild variant="outline">
          <Link href="/workspace/pipeline/second-opinions">
            Back to second opinions
          </Link>
        </Button>
      </Empty>
    );
  async function save(outcome: "closer_right" | "second_opinion_right") {
    setBusy(true);
    try {
      await check({ secondOpinionId, outcome });
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not check this disagreement."));
    } finally {
      setBusy(false);
    }
  }
  async function runAgain() {
    setBusy(true);
    try {
      const id = await rerun({ secondOpinionId });
      router.push(`/workspace/pipeline/second-opinions/${id}`);
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not run Jev again."));
    } finally {
      setBusy(false);
    }
  }
  const { opinion } = detail;
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {detail.person} · {localDate(detail.scheduledAt, detail.timeZone)}{" "}
            call
          </h1>
          <p className="text-sm text-muted-foreground">
            {detail.closer} · {detail.program ?? "Sales call"}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <OpinionChip detail={detail} />
          {detail.canRerun && opinion.status !== "queued" && (
            <Button variant="outline" size="sm" disabled={busy} onClick={runAgain}>
              Run Jev again
            </Button>
          )}
        </div>
      </header>
      {opinion.supersededById && (
        <Alert>
          <AlertDescription>
            A newer check replaced this one.{" "}
            <Link
              className="underline underline-offset-4"
              href={`/workspace/pipeline/second-opinions/${opinion.supersededById}`}
            >
              Open the newer check
            </Link>
          </AlertDescription>
        </Alert>
      )}
      {opinion.status !== "answered" && (
        <Alert>
          <AlertDescription>
            {opinion.status === "queued"
              ? "Jev is checking this call. This page updates when it answers."
              : (failureLabels[opinion.failure ?? ""] ??
                "Jev didn't answer this check.")}
          </AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Second opinion</CardTitle>
          <CardDescription>
            Jev ·{" "}
            {localDate(
              detail.opinion.answeredAt ?? detail.opinion.createdAt,
              detail.timeZone,
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <h2 className="text-sm text-muted-foreground">
                {detail.closer} recorded
              </h2>
              <p className="text-lg font-semibold">
                {recordLabel(detail.opinion.record)}
              </p>
            </div>
            <div className="flex flex-col gap-1">
              <h2 className="text-sm text-muted-foreground">Jev heard</h2>
              <p className="text-lg font-semibold">{heardLabel(opinion)}</p>
            </div>
          </div>
          <OpinionAnswers detail={detail} />
          {opinion.calls !== undefined && (
            <p className="text-xs text-muted-foreground">
              Jev answered {opinion.calls} times: each group of questions once
              with Fathom&apos;s summary and once from the transcript alone.
              {opinion.split?.length
                ? ` The two readings differed on ${opinion.split
                    .map((q) => readingNames[q] ?? q)
                    .join(", ")}.`
                : " Both readings agreed."}
            </p>
          )}
        </CardContent>
        <CardFooter>
          <OpinionReviewFooter detail={detail} />
        </CardFooter>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Evidence</CardTitle>
          <CardDescription>Fathom recording</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <OpinionEvidence detail={detail} />
          {detail.summary && (
            <div>
              <h3 className="mb-1 text-sm font-medium">Summary</h3>
              <RecordingSummary markdown={detail.summary} />
            </div>
          )}
          {detail.actionItems.length > 0 && (
            <div>
              <h3 className="mb-1 text-sm font-medium">Action items</h3>
              <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
                {detail.actionItems.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
        <CardFooter className="flex flex-wrap justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            Measured from the transcript, not by Jev
          </p>
          {detail.recordingUrl && (
            <Button asChild variant="link">
              <a href={detail.recordingUrl} target="_blank" rel="noreferrer">
                Listen
              </a>
            </Button>
          )}
        </CardFooter>
      </Card>
      {detail.opinion.closerNote && (
        <Card>
          <CardHeader>
            <CardTitle>{detail.closer}&apos;s note</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-sm">
              {detail.opinion.closerNote}
            </p>
          </CardContent>
        </Card>
      )}
      {detail.canReview && detail.opinion.reviewState === "open" && (
        <div className="flex flex-wrap justify-end gap-3">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => save("closer_right")}
          >
            The closer&apos;s record stands
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              detail.canReopen ? setDialog(true) : save("second_opinion_right")
            }
          >
            The second opinion is right
          </Button>
        </div>
      )}
      {dialog && (
        <ReopenDialog detail={detail} onClose={() => setDialog(false)} />
      )}
    </div>
  );
}
