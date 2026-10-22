"use client";

import { useState } from "react";
import Link from "next/link";
import type { FunctionReturnType } from "convex/server";
import { usePreloadedQuery, useMutation, type Preloaded } from "convex/react";
import { format } from "date-fns";
import {
  ArrowLeftIcon,
  CheckIcon,
  ExternalLinkIcon,
  GitMergeIcon,
  RotateCcwIcon,
  SplitIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { usePageTitle } from "@/hooks/use-page-title";
import { getErrorMessage } from "@/lib/errors";
import {
  opportunityStatusConfig,
  type OpportunityStatus,
} from "@/lib/status-config";
import { cn } from "@/lib/utils";
import {
  IDENTIFIER_SOURCE_LABELS,
  MATCH_LABELS,
  RESOLUTION_LABELS,
} from "../../_components/booking-review-labels";

type Review = NonNullable<FunctionReturnType<typeof api.pipeline.bookingReviews.get>>;
type Person = Review["people"][number];

const personName = (person: Person | undefined) => person?.name ?? "Unnamed person";

export function BookingReviewPageClient({
  preloadedReview,
}: {
  preloadedReview: Preloaded<typeof api.pipeline.bookingReviews.get>;
}) {
  const review = usePreloadedQuery(preloadedReview);
  usePageTitle(review?.booking.inviteeName ? `${review.booking.inviteeName} — Booking Review` : "Booking Review");

  if (review === null) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>Booking review not found</EmptyTitle>
          <EmptyDescription>
            It may belong to another workspace, or the link is incomplete.
          </EmptyDescription>
        </EmptyHeader>
        <Button asChild variant="outline">
          <Link href="/workspace/operations/booking-reviews">All booking reviews</Link>
        </Button>
      </Empty>
    );
  }

  const booked = review.people.find((person) => person.role === "booked");
  const matched = review.people.filter((person) => person.role === "matched");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/workspace/operations/booking-reviews">
            <ArrowLeftIcon data-icon="inline-start" />
            Booking Reviews
          </Link>
        </Button>
        {review.status === "open" ? (
          <Badge variant={review.kind === "held" ? "destructive" : "secondary"}>
            {review.kind === "held" ? "Held, not in the CRM" : "Needs a decision"}
          </Badge>
        ) : (
          <Badge variant="outline">Resolved</Badge>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          {review.kind === "attached" ? "Booking matched two people" : "Booking held for review"}
        </h1>
        <p className="text-sm text-muted-foreground">
          Received {format(review.createdAt, "MMM d, yyyy 'at' h:mm a")}
        </p>
      </div>

      <Alert variant={review.kind === "held" && review.status === "open" ? "destructive" : "default"}>
        <TriangleAlertIcon aria-hidden="true" />
        <AlertTitle>What happened</AlertTitle>
        <AlertDescription>
          <SummaryText review={review} booked={booked} matched={matched} />
        </AlertDescription>
      </Alert>

      <BookingCard review={review} />

      <section aria-label="People this booking matched" className="grid gap-6 lg:grid-cols-2">
        {review.people.map((person) => (
          <PersonCard key={person.leadId} person={person} />
        ))}
      </section>

      {review.status === "open" ? (
        <DecisionCard review={review} booked={booked} matched={matched} />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckIcon aria-hidden="true" className="size-4" />
              {review.resolution ? RESOLUTION_LABELS[review.resolution] : "Resolved"}
            </CardTitle>
            <CardDescription>
              {review.resolvedByName ? `By ${review.resolvedByName}` : "By the pipeline"}
              {review.resolvedAt ? ` on ${format(review.resolvedAt, "MMM d, yyyy 'at' h:mm a")}` : ""}.
            </CardDescription>
          </CardHeader>
        </Card>
      )}
    </div>
  );
}

function SummaryText({
  review,
  booked,
  matched,
}: {
  review: Review;
  booked: Person | undefined;
  matched: Person[];
}) {
  const invitee = review.booking.inviteeName ?? "Someone";
  const named = matched.map((person) => (
    <span key={person.leadId}>
      {" "}its {person.matchedBy.map((via) => MATCH_LABELS[via]).join(" and ")} belongs to{" "}
      <strong className="font-medium text-foreground">{personName(person)}</strong>.
    </span>
  ));
  if (review.kind === "attached" && booked) {
    return (
      <p>
        {invitee}&apos;s Instagram handle belongs to{" "}
        <strong className="font-medium text-foreground">{personName(booked)}</strong>, so the
        call went to them. But{named} If they&apos;re the same person, merge them. If not, keep
        them separate: nothing moves.
      </p>
    );
  }
  return (
    <p>
      The CRM is holding {invitee}&apos;s booking because its details name more than one
      person.{named.length ? named : null} The call isn&apos;t in the CRM until someone
      decides who it belongs to.
    </p>
  );
}

function formatInviteeTime(at: number, timeZone: string | undefined) {
  if (!timeZone) return null;
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone,
      timeZoneName: "short",
    }).format(at);
  } catch {
    return null;
  }
}

function BookingCard({ review }: { review: Review }) {
  const { booking } = review;
  const inviteeTime =
    booking.startTime !== undefined ? formatInviteeTime(booking.startTime, booking.timezone) : null;
  const rows: { label: string; value: React.ReactNode }[] = [
    { label: "Invitee", value: booking.inviteeName },
    { label: "Email", value: booking.email },
    { label: "Phone", value: booking.phone },
    { label: "Instagram", value: booking.socialHandle && `@${booking.socialHandle.handle}` },
    {
      label: "Call",
      value:
        booking.startTime !== undefined ? (
          <span className="flex flex-col">
            <span>{format(booking.startTime, "EEE, MMM d 'at' h:mm a")} your time</span>
            {inviteeTime && (
              <span className="text-xs text-muted-foreground">{inviteeTime} for the invitee</span>
            )}
          </span>
        ) : undefined,
    },
    { label: "Event", value: booking.eventName },
    {
      label: "Host",
      value: booking.hostName && (
        <span className="flex flex-col">
          <span>{booking.hostName}</span>
          {booking.hostEmail && (
            <span className="text-xs text-muted-foreground">{booking.hostEmail}</span>
          )}
        </span>
      ),
    },
    { label: "Booked via", value: booking.bookedVia },
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>The booking</CardTitle>
        <CardDescription>
          What the invitee typed on the Calendly form.
          {!booking.payloadAvailable &&
            " The full form is past its 30-day retention; only the identifiers remain."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          {rows.map((row) =>
            row.value ? (
              <div key={row.label} className="min-w-0">
                <dt className="text-muted-foreground">{row.label}</dt>
                <dd className="font-medium break-words">{row.value}</dd>
              </div>
            ) : null,
          )}
        </dl>
        {booking.answers.length > 0 && (
          <details className="group rounded-lg border p-3 text-sm">
            <summary className="cursor-pointer font-medium">
              Form answers ({booking.answers.length})
            </summary>
            <dl className="mt-3 flex flex-col gap-3">
              {booking.answers.map((answer) => (
                <div key={answer.question}>
                  <dt className="text-muted-foreground">{answer.question}</dt>
                  <dd>{answer.answer}</dd>
                </div>
              ))}
            </dl>
          </details>
        )}
      </CardContent>
      {booking.meetingId && (
        <CardFooter>
          <Button asChild variant="outline" size="sm">
            <Link href={`/workspace/pipeline/meetings/${booking.meetingId}`}>
              Open the meeting
              <ExternalLinkIcon data-icon="inline-end" />
            </Link>
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}

function PersonCard({ person }: { person: Person }) {
  const role =
    person.role === "booked"
      ? "Booking went to"
      : `Also matched by ${person.matchedBy.map((via) => MATCH_LABELS[via]).join(" and ")}`;
  return (
    <Card className={cn(person.role === "booked" && "border-primary/40")}>
      <CardHeader>
        <CardDescription>{role}</CardDescription>
        <CardTitle className="text-lg">{personName(person)}</CardTitle>
        {person.status === "merged" && (
          <Badge variant="outline" className="w-fit">Merged into another person</Badge>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-5 text-sm">
        {person.checks.length > 0 && (
          <ul className="flex flex-wrap gap-2" aria-label="Compared with the booking">
            {person.checks.map((check) => (
              <li key={check.label}>
                <Badge
                  variant="outline"
                  className={cn(
                    check.same
                      ? "border-emerald-300 text-emerald-700 dark:border-emerald-900 dark:text-emerald-400"
                      : "border-amber-300 text-amber-700 dark:border-amber-900 dark:text-amber-400",
                  )}
                >
                  {check.same ? <CheckIcon aria-hidden="true" /> : <XIcon aria-hidden="true" />}
                  {check.same ? "Same" : "Different"} {check.label}
                </Badge>
              </li>
            ))}
          </ul>
        )}

        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <PersonField label="Email" value={person.email} />
          <PersonField label="Phone" value={person.phone} />
          <PersonField
            label="Instagram"
            value={person.handles.map((handle) => `@${handle.handle}`).join(", ")}
          />
          <PersonField label="First seen" value={format(person.firstSeenAt, "MMM d, yyyy")} />
        </dl>

        <div className="flex flex-col gap-2">
          <h3 className="font-medium">Deals</h3>
          {person.deals.length === 0 ? (
            <p className="text-muted-foreground">No deals.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {person.deals.map((deal) => {
                const config = opportunityStatusConfig[deal.status as OpportunityStatus];
                return (
                  <li key={deal.opportunityId} className="flex flex-col gap-1 rounded-lg border p-3">
                    <span className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary" className={cn(config?.badgeClass)}>
                        {config?.label ?? deal.status}
                      </Badge>
                      <span className="text-muted-foreground">
                        Created {format(deal.createdAt, "MMM d")}
                      </span>
                    </span>
                    <span className="text-muted-foreground">
                      {[
                        (deal.closerName ?? deal.hostName) && `Closer: ${deal.closerName ?? deal.hostName}`,
                        deal.latestMeetingAt !== undefined &&
                          `Call ${format(deal.latestMeetingAt, "MMM d, h:mm a")}`,
                        deal.qualifiedByName && `Qualified by ${deal.qualifiedByName}`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {person.identifiers.length > 0 && (
          <div className="flex flex-col gap-2">
            <h3 className="font-medium">Known identifiers</h3>
            <ul className="flex flex-col gap-1 text-muted-foreground">
              {person.identifiers.map((identifier) => (
                <li key={`${identifier.type}:${identifier.value}`} className="break-words">
                  <span className="text-foreground">{identifier.value}</span>
                  {" · "}
                  {IDENTIFIER_SOURCE_LABELS[identifier.source] ?? identifier.source}
                  {", "}
                  {format(identifier.createdAt, "MMM d")}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
      <CardFooter>
        <Button asChild variant="outline" size="sm">
          <Link href={`/workspace/leads-customers/${person.leadId}`}>
            Open person
            <ExternalLinkIcon data-icon="inline-end" />
          </Link>
        </Button>
      </CardFooter>
    </Card>
  );
}

function PersonField({ label, value }: { label: string; value: string | undefined }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium break-words">{value || "—"}</dd>
    </div>
  );
}

function DecisionCard({
  review,
  booked,
  matched,
}: {
  review: Review;
  booked: Person | undefined;
  matched: Person[];
}) {
  const mergePeople = useMutation(api.pipeline.bookingReviews.mergePeople);
  const keepSeparate = useMutation(api.pipeline.bookingReviews.keepSeparate);
  const closeAsMerged = useMutation(api.pipeline.bookingReviews.closeAsMerged);
  const retryBooking = useMutation(api.pipeline.bookingReviews.retryBooking);
  const [pending, setPending] = useState<"merge" | "separate" | "retry" | null>(null);
  const [confirmMerge, setConfirmMerge] = useState(false);
  const mergeable = review.people.filter((person) => person.status !== "merged");
  const [keepLeadId, setKeepLeadId] = useState<Id<"leads"> | undefined>(
    booked?.leadId ?? mergeable[0]?.leadId,
  );
  const keep = review.people.find((person) => person.leadId === keepLeadId);
  const others = review.people.filter((person) => person.leadId !== keepLeadId);
  const otherNames = others.map(personName).join(" and ");

  async function run(
    kind: "merge" | "separate" | "retry",
    action: () => Promise<{ alsoClosed: number } | null>,
    done: string,
  ) {
    setPending(kind);
    try {
      const alsoClosed = (await action())?.alsoClosed ?? 0;
      toast.success(
        alsoClosed > 0
          ? `${done} ${alsoClosed} other review${alsoClosed === 1 ? "" : "s"} about the same people closed too.`
          : done,
      );
    } catch (error) {
      toast.error(getErrorMessage(error, "That didn't work. Nothing was changed."));
    } finally {
      setPending(null);
      setConfirmMerge(false);
    }
  }

  const canMerge = mergeable.length > 1 && keepLeadId !== undefined;
  // Merged on another review or the Leads page: one person is left, and
  // closing records the merge.
  const alreadyOne = review.alreadyOnePerson;
  // A held booking is retried only while its original Calendly payload is kept.
  const retriesBooking = review.kind === "held" && review.booking.payloadAvailable;
  const heldBookingOutcome =
    review.kind !== "held"
      ? ""
      : retriesBooking
        ? ", and the booking is retried"
        : ". The booking's original data is gone, so it stays held";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Decide</CardTitle>
        <CardDescription>
          {review.kind === "attached"
            ? "The call is already on the CRM. This only decides whether the two records are one person."
            : "Nothing about this booking is in the CRM yet."}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-3 rounded-lg border p-4">
          <div className="flex items-center gap-2 font-medium">
            <GitMergeIcon aria-hidden="true" className="size-4" />
            Same person
          </div>
          {review.kind === "held" && mergeable.length > 1 ? (
            <RadioGroup
              value={keepLeadId}
              onValueChange={(value) => setKeepLeadId(value as Id<"leads">)}
              aria-label="Record to keep"
            >
              {mergeable.map((person) => (
                <div key={person.leadId} className="flex items-center gap-2">
                  <RadioGroupItem value={person.leadId} id={`keep-${person.leadId}`} />
                  <Label htmlFor={`keep-${person.leadId}`} className="font-normal">
                    Keep {personName(person)} ({person.deals.length} deal{person.deals.length === 1 ? "" : "s"})
                  </Label>
                </div>
              ))}
            </RadioGroup>
          ) : null}
          <p className="text-sm text-muted-foreground">
            {alreadyOne
              ? `Already one person: they were merged elsewhere. Close this review${heldBookingOutcome}.`
              : canMerge
                ? `Merge ${otherNames} into ${personName(keep)}. Deals, calls and identifiers move to one record${heldBookingOutcome}.`
                : mergeable.length > 1
                  ? "Choose the record to keep."
                  : "One of these people was merged into someone else or no longer exists. Check them on the Leads page."}
          </p>
          {alreadyOne ? (
            <Button
              className="mt-auto w-fit"
              disabled={pending !== null}
              onClick={() =>
                void run("merge", () => closeAsMerged({ reviewId: review.reviewId }), "Closed as one person.")
              }
            >
              {pending === "merge" ? <Spinner data-icon="inline-start" /> : <CheckIcon data-icon="inline-start" />}
              Close as merged
            </Button>
          ) : (
            <Button
              className="mt-auto w-fit"
              disabled={!canMerge || pending !== null}
              onClick={() => setConfirmMerge(true)}
            >
              {pending === "merge" ? <Spinner data-icon="inline-start" /> : <GitMergeIcon data-icon="inline-start" />}
              {retriesBooking ? "Merge and retry the booking" : `Merge into ${personName(keep)}`}
            </Button>
          )}
        </div>

        <div className="flex flex-col gap-3 rounded-lg border p-4">
          <div className="flex items-center gap-2 font-medium">
            <SplitIcon aria-hidden="true" className="size-4" />
            Different people
          </div>
          <p className="text-sm text-muted-foreground">
            {review.kind === "attached" && booked
              ? `${personName(booked)} keeps the call. ${matched.map(personName).join(" and ")} keeps the ${[...new Set(matched.flatMap((person) => person.matchedBy))].map((via) => MATCH_LABELS[via]).join(" and ")}. A later booking with the same mix won't alert again. If the email was a typo, ask the setter to rebook with the right one.`
              : "The booking stays held. Fix the person records and retry, or leave it held in Booked Calls → Diagnostics."}
          </p>
          <div className="mt-auto flex flex-wrap gap-2">
            {review.kind === "held" && (
              <Button
                variant="outline"
                disabled={pending !== null}
                onClick={() =>
                  run("retry", () => retryBooking({ reviewId: review.reviewId }), "Booking sent for another try.")
                }
              >
                {pending === "retry" ? <Spinner data-icon="inline-start" /> : <RotateCcwIcon data-icon="inline-start" />}
                Retry booking
              </Button>
            )}
            <Button
              variant="outline"
              disabled={pending !== null}
              onClick={() =>
                run("separate", () => keepSeparate({ reviewId: review.reviewId }), "Kept as different people.")
              }
            >
              {pending === "separate" ? <Spinner data-icon="inline-start" /> : <SplitIcon data-icon="inline-start" />}
              {review.kind === "attached" ? "Keep separate" : "Close review"}
            </Button>
          </div>
        </div>
      </CardContent>

      <AlertDialog open={confirmMerge} onOpenChange={setConfirmMerge}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Merge {otherNames} into {personName(keep)}?</AlertDialogTitle>
            <AlertDialogDescription>
              {otherNames} stops being a separate person. Their deals, calls, payments and
              identifiers move to {personName(keep)}. A merge can&apos;t be undone from here.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending !== null}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending !== null || !keepLeadId}
              onClick={(event) => {
                event.preventDefault();
                if (!keepLeadId) return;
                void run(
                  "merge",
                  () => mergePeople({ reviewId: review.reviewId, keepLeadId }),
                  retriesBooking ? "Merged. The booking is being retried." : "Merged into one person.",
                );
              }}
            >
              {pending === "merge" && <Spinner data-icon="inline-start" />}
              Merge
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
