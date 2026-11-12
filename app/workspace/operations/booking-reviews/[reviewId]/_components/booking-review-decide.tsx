"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { useMutation } from "convex/react";
import { CheckIcon, GitMergeIcon, RotateCcwIcon, SplitIcon, UserPlusIcon, UserCheckIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
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
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { CARD, HelpTip } from "@/app/workspace/team/_components/team-ui";
import { detailLinkClass } from "@/app/workspace/closer/meetings/_components/detail-card";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import { getErrorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { holdNextStep } from "@/convex/pipeline/holdNextStep";
import { MATCH_LABELS, RESOLUTION_LABELS } from "../../_components/booking-review-labels";
import { dayAndClock, personName, type Person, type Review } from "./booking-review-compare";

// The rail: the decision in the Outcome Panel's grammar (a 2px lime border,
// the two answers as blocks, each with one line saying what it does), or,
// once resolved, a plain card saying what was decided, with no lime.

function ChoiceHead({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <h3 className="flex items-center gap-2 text-[15px] font-semibold [&_svg]:size-4 [&_svg]:text-muted-foreground">
      {icon}
      {children}
    </h3>
  );
}

export function DecidePanel({
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
  const [keepLeadId, setKeepLeadId] = useState<Id<"leads"> | undefined>(booked?.leadId ?? mergeable[0]?.leadId);
  const keep = review.people.find((person) => person.leadId === keepLeadId);
  const others = review.people.filter((person) => person.leadId !== keepLeadId);
  const otherNames = others.map(personName).join(" and ");
  const titleId = useId();

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
  const mergeLine = alreadyOne
    ? `Already merged elsewhere. Closing records it${
        review.kind !== "held" ? "." : retriesBooking ? " and retries the booking." : "; the booking's data is gone, so it stays held."
      }`
    : canMerge
      ? `Merges ${otherNames} into ${personName(keep)}${
          review.kind !== "held" ? "." : retriesBooking ? " and retries the booking." : ". The booking's data is gone, so it stays held."
        }`
      : mergeable.length > 1
        ? "Choose the record to keep."
        : "One of them was merged away or deleted. Check them in Leads & Customers.";
  const vias = [...new Set(matched.flatMap((person) => person.matchedBy))].map((via) => MATCH_LABELS[via]).join(" and ");
  // A held review books the call for the email's person when the other one
  // matched by phone only; any other mix needs a merge or a fix first.
  const bookFor = review.people.find((person) => person.leadId === review.separateBooksForLeadId);
  const phoneKeeper = review.people.filter((person) => person.leadId !== review.separateBooksForLeadId);
  const separateLine =
    review.kind === "attached" && booked
      ? `${personName(booked)} keeps the call; ${matched.map(personName).join(" and ")} keeps the ${vias}.`
      : bookFor && retriesBooking
        ? `Books the call for ${personName(bookFor)}, who owns the email. ${phoneKeeper.map(personName).join(" and ")} keeps the phone.`
        : "These people can't be told apart from here. Merge them, or fix who holds the email or phone in Leads & Customers, then retry.";

  return (
    <section aria-labelledby={titleId} className="@container/decide overflow-hidden rounded-xl border-2 border-primary bg-card">
      <h2 id={titleId} className="px-4 pt-3 pb-2.5 text-[20px] leading-tight font-semibold @sm/decide:px-5">
        Same person?
      </h2>

      <div className="flex flex-col gap-2 px-4 pb-4 @sm/decide:px-5">
        {/* Yes: the page's one next action */}
        <div className="flex flex-col gap-2.5 rounded-[7px] border border-primary/60 bg-primary/10 p-3">
          <ChoiceHead icon={<GitMergeIcon aria-hidden="true" />}>Same person</ChoiceHead>
          {review.kind === "held" && mergeable.length > 1 && !alreadyOne ? (
            <RadioGroup
              value={keepLeadId}
              onValueChange={(value) => setKeepLeadId(value as Id<"leads">)}
              aria-label="Record to keep"
              className="gap-1"
            >
              {mergeable.map((person) => (
                <div key={person.leadId} className="flex min-h-6 items-center gap-2">
                  <RadioGroupItem value={person.leadId} id={`keep-${person.leadId}`} />
                  <Label htmlFor={`keep-${person.leadId}`} className="text-[14px] font-normal">
                    Keep {personName(person)}{" "}
                    <span className="text-muted-foreground">
                      ({person.deals.length} deal{person.deals.length === 1 ? "" : "s"})
                    </span>
                  </Label>
                </div>
              ))}
            </RadioGroup>
          ) : null}
          <p className="text-[13px] text-muted-foreground">{mergeLine}</p>
          {alreadyOne ? (
            <Button
              className="w-fit font-semibold"
              disabled={pending !== null}
              onClick={() => void run("merge", () => closeAsMerged({ reviewId: review.reviewId }), "Closed as one person.")}
            >
              {pending === "merge" ? <Spinner data-icon="inline-start" /> : <CheckIcon data-icon="inline-start" />}
              Close as merged
            </Button>
          ) : (
            <Button className="w-fit font-semibold" disabled={!canMerge || pending !== null} onClick={() => setConfirmMerge(true)}>
              {pending === "merge" ? <Spinner data-icon="inline-start" /> : <GitMergeIcon data-icon="inline-start" />}
              {retriesBooking ? "Merge and retry the booking" : `Merge into ${personName(keep)}`}
            </Button>
          )}
        </div>

        {/* No */}
        <div className="flex flex-col gap-2.5 rounded-[7px] border border-border p-3">
          <ChoiceHead icon={<SplitIcon aria-hidden="true" />}>
            {review.kind === "attached" ? (
              <HelpTip tip="A later booking with the same mix won't alert again. If the email was a typo, ask the setter to rebook with the right one.">
                Different people
              </HelpTip>
            ) : (
              "Different people"
            )}
          </ChoiceHead>
          <p className="text-[13px] text-muted-foreground">{separateLine}</p>
          <div className="flex flex-wrap gap-2">
            {review.kind === "held" ? (
              <Button
                variant="outline"
                disabled={pending !== null}
                onClick={() => run("retry", () => retryBooking({ reviewId: review.reviewId }), "Booking sent for another try.")}
              >
                {pending === "retry" ? <Spinner data-icon="inline-start" /> : <RotateCcwIcon data-icon="inline-start" />}
                Retry booking
              </Button>
            ) : null}
            {review.kind === "attached" ? (
              <Button
                variant="outline"
                disabled={pending !== null}
                onClick={() => run("separate", () => keepSeparate({ reviewId: review.reviewId }), "Kept as different people.")}
              >
                {pending === "separate" ? <Spinner data-icon="inline-start" /> : <SplitIcon data-icon="inline-start" />}
                Keep separate
              </Button>
            ) : bookFor && retriesBooking ? (
              <Button
                variant="outline"
                disabled={pending !== null}
                onClick={() =>
                  run(
                    "separate",
                    () => keepSeparate({ reviewId: review.reviewId, bookForEmailOwner: true }),
                    `Kept apart. The call is being added for ${personName(bookFor)}.`,
                  )
                }
              >
                {pending === "separate" ? <Spinner data-icon="inline-start" /> : <SplitIcon data-icon="inline-start" />}
                Book for {personName(bookFor)}
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex min-h-10 items-center border-t border-border bg-background px-4 text-[13px] @sm/decide:px-5">
        <Link href="/workspace/operations/booking-reviews" className={cn(detailLinkClass, "text-[13px]")}>
          Back to Booking Reviews
        </Link>
      </div>

      <AlertDialog open={confirmMerge} onOpenChange={setConfirmMerge}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Merge {otherNames} into {personName(keep)}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {otherNames} stops being a separate person. Their deals, calls, payments and identifiers move to{" "}
              {personName(keep)}. A merge can&apos;t be undone from here.
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
    </section>
  );
}

/** Why "Is this the same person?" can't be answered right now, if it can't. */
function identityCheckBlocker(review: Review) {
  if (review.deliveryStatus === "queued") return "This booking is being processed. Wait a moment.";
  if (review.waitingOnDeliveryId) return "An earlier booking from this person is waiting. Decide that one first.";
  if (!review.booking.payloadAvailable) return "The booking's original data is gone, so it can't be added from here.";
  if (review.deliveryStatus === "blocked" && review.deliveryReason !== "phone_match_new_email")
    return `This booking is now held for another reason. ${holdNextStep(review.deliveryReason).cause}`;
  return null;
}

/**
 * "Is this the same person?": the booking's email is new, and its phone names
 * one person who already has a different email. Either answer adds the call
 * and is remembered for later bookings with that email.
 */
export function IdentityCheckPanel({ review, person }: { review: Review; person: Person | undefined }) {
  const decide = useMutation(api.pipeline.identityDecisions.decideIdentityCheck);
  const retryBooking = useMutation(api.pipeline.bookingReviews.retryBooking);
  const [pending, setPending] = useState<"same_person" | "different_person" | "retry" | null>(null);
  const now = useNow();
  const titleId = useId();
  const name = person ? personName(person) : "the person on file";
  const email = review.booking.email;
  const blocker = identityCheckBlocker(review);
  const callPast = review.booking.startTime !== undefined && review.booking.startTime < now;

  async function answer(decision: "same_person" | "different_person", done: string) {
    setPending(decision);
    try {
      await decide({ reviewId: review.reviewId, decision });
      toast.success(done);
    } catch (error) {
      toast.error(getErrorMessage(error, "That didn't work. Nothing was changed."));
    } finally {
      setPending(null);
    }
  }

  async function checkAgain() {
    setPending("retry");
    try {
      await retryBooking({ reviewId: review.reviewId });
      toast.success("Checking the booking again.");
    } catch (error) {
      toast.error(getErrorMessage(error, "That didn't work. Nothing was changed."));
    } finally {
      setPending(null);
    }
  }

  return (
    <section aria-labelledby={titleId} className="@container/decide overflow-hidden rounded-xl border-2 border-primary bg-card">
      <h2 id={titleId} className="px-4 pt-3 pb-2.5 text-[20px] leading-tight font-semibold @sm/decide:px-5">
        Is this {name}?
      </h2>
      <div className="flex flex-col gap-2 px-4 pb-4 @sm/decide:px-5">
        {blocker ? <p className="text-[13px] text-warning-ink">{blocker}</p> : null}
        {callPast ? (
          <p className="text-[13px] text-muted-foreground">
            This call has already happened. Once it&apos;s added, the closer records whether it was held.
          </p>
        ) : null}

        <div className="flex flex-col gap-2.5 rounded-[7px] border border-primary/60 bg-primary/10 p-3">
          <ChoiceHead icon={<UserCheckIcon aria-hidden="true" />}>Same person</ChoiceHead>
          <p className="text-[13px] text-muted-foreground">
            {review.linkAllowsSamePerson
              ? `Adds the call for ${name}${email ? ` and keeps ${email} as one of their emails` : ""}. Their main email doesn't change.`
              : "This booking came from a link for another person's deal. An operator has to place it."}
          </p>
          <Button
            className="w-fit font-semibold"
            disabled={pending !== null || blocker !== null || !review.linkAllowsSamePerson}
            onClick={() => void answer("same_person", `Added for ${name}.`)}
          >
            {pending === "same_person" ? <Spinner data-icon="inline-start" /> : <UserCheckIcon data-icon="inline-start" />}
            Same person
          </Button>
        </div>

        <div className="flex flex-col gap-2.5 rounded-[7px] border border-border p-3">
          <ChoiceHead icon={<UserPlusIcon aria-hidden="true" />}>Different person</ChoiceHead>
          <p className="text-[13px] text-muted-foreground">
            {review.linkBooking
              ? "This booking came from a CRM booking link, so it can't go to a new person."
              : `Adds the call for a new person${email ? ` with ${email}` : ""}. ${name} keeps the phone.`}
          </p>
          <Button
            variant="outline"
            className="w-fit"
            disabled={pending !== null || blocker !== null || review.linkBooking}
            onClick={() => void answer("different_person", "Added for a new person.")}
          >
            {pending === "different_person" ? <Spinner data-icon="inline-start" /> : <UserPlusIcon data-icon="inline-start" />}
            Different person
          </Button>
        </div>

        <p className="text-[13px] text-muted-foreground">
          The answer is remembered for this email&apos;s later bookings.{" "}
          <button
            type="button"
            className={cn(detailLinkClass, "text-[13px]")}
            disabled={pending !== null || review.deliveryStatus !== "blocked"}
            onClick={() => void checkAgain()}
          >
            Check again
          </button>{" "}
          after fixing someone on the Leads page.
        </p>
      </div>
      <div className="flex min-h-10 items-center border-t border-border bg-background px-4 text-[13px] @sm/decide:px-5">
        <Link href="/workspace/operations/booking-reviews" className={cn(detailLinkClass, "text-[13px]")}>
          Back to Booking Reviews
        </Link>
      </div>
    </section>
  );
}

/** Where the booking stands now, which a retry after the decision can change. */
function liveBookingLine(review: Review) {
  if (review.kind === "attached") return null;
  if (review.deliveryStatus === "applied") return "The booking is in the CRM.";
  if (review.deliveryStatus === "queued") return "The booking is being added.";
  if (review.deliveryStatus === "blocked" || review.deliveryStatus === "failed") {
    const why = holdNextStep(review.deliveryReason);
    return `The booking is still held. ${why.cause} ${why.nextStep}`;
  }
  return null;
}

/** A resolved review: what was decided, by whom and when. No lime. */
export function ResolvedCard({ review }: { review: Review }) {
  const { setting } = useBusinessDay();
  const now = useNow();
  const live = liveBookingLine(review);
  return (
    <section aria-labelledby="resolved-title" className={CARD}>
      <div className="flex min-h-11 items-center gap-2.5 border-b border-border px-4 py-2">
        <CheckIcon aria-hidden="true" className="size-4 text-muted-foreground" />
        <h2 id="resolved-title" className="text-[15px] font-semibold">
          {review.resolution ? RESOLUTION_LABELS[review.resolution] : "Resolved"}
        </h2>
      </div>
      <p className="px-4 py-2.5 text-[13px] text-muted-foreground">
        {review.resolvedByName ? (
          <>
            By <span className="font-medium text-foreground">{review.resolvedByName}</span>
          </>
        ) : (
          "By the pipeline"
        )}
        {review.resolvedAt ? (
          <>
            {" · "}
            <span className="font-condensed text-[14px] font-semibold text-foreground tabular-nums">
              {dayAndClock(review.resolvedAt, setting, now)}
            </span>
          </>
        ) : null}
      </p>
      {live ? <p className="px-4 pb-2.5 text-[13px] text-foreground">{live}</p> : null}
      <div className="flex min-h-10 items-center border-t border-border px-4">
        <Link href="/workspace/operations/booking-reviews" className={cn(detailLinkClass, "text-[13px]")}>
          Back to Booking Reviews
        </Link>
      </div>
    </section>
  );
}
