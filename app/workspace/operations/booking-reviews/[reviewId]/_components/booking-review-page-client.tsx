"use client";

import { usePreloadedQuery, type Preloaded } from "convex/react";
import type { api } from "@/convex/_generated/api";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { detailLinkClass } from "@/app/workspace/closer/meetings/_components/detail-card";
import { PageBand } from "@/app/workspace/_components/page-band";
import { CARD } from "@/app/workspace/team/_components/team-ui";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import { usePageTitle } from "@/hooks/use-page-title";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { MATCH_LABELS } from "../../_components/booking-review-labels";
import { REVIEW_WORD_CLASS, ReviewStatusWord } from "../../_components/booking-review-ui";
import { BookingCard, PersonCard, dayAndClock, personName, type Person, type Review } from "./booking-review-cards";
import { DecidePanel, ResolvedCard } from "./booking-review-decide";

// One booking review: the band says what happened, the main column holds
// the booking and the people it matched, and the rail holds the decision.

const BACK = { href: "/workspace/operations/booking-reviews", label: "Booking Reviews" };

export function BookingReviewPageClient({
  preloadedReview,
}: {
  preloadedReview: Preloaded<typeof api.pipeline.bookingReviews.get>;
}) {
  const review = usePreloadedQuery(preloadedReview);
  usePageTitle(review?.booking.inviteeName ? `${review.booking.inviteeName} — Booking Review` : "Booking Review");
  const { setting } = useBusinessDay();
  const now = useNow();

  if (review === null) {
    return (
      <div className="@container mx-auto flex w-full max-w-[1500px] min-w-0 flex-col gap-3.5 pb-6 short:gap-3">
        <PageBand back={BACK} title="Booking review not found" />
        <div className={CARD}>
          <SectionEmpty title="This booking review doesn't exist here.">
            It may belong to another workspace, or the link is incomplete.{" "}
            <Link href={BACK.href} className={cn(detailLinkClass, "text-[13px]")}>
              All booking reviews
            </Link>
          </SectionEmpty>
        </div>
      </div>
    );
  }

  const booked = review.people.find((person) => person.role === "booked");
  const matched = review.people.filter((person) => person.role === "matched");
  const open = review.status === "open";

  return (
    <div className="@container mx-auto flex w-full max-w-[1500px] min-w-0 flex-col gap-3.5 pb-6 short:gap-3">
      <PageBand
        back={BACK}
        title={review.kind === "attached" ? "Booking matched two people" : "Booking held for review"}
        description={
          <>
            Received {dayAndClock(review.createdAt, setting, now)}
            {review.booking.eventName ? ` · ${review.booking.eventName}` : null}
          </>
        }
        actions={
          <ReviewStatusWord
            kind={review.kind}
            open={open}
            className={cn(REVIEW_WORD_CLASS, "text-[17px]", !open && "text-board-muted")}
          />
        }
      >
        <div className="-mx-4 border-t border-board-line px-4 pt-3 pb-3.5 text-[14px] text-board-foreground/80 @lg:-mx-[18px] @lg:px-[18px]">
          <p className="sr-only">What happened</p>
          <SummaryText review={review} booked={booked} matched={matched} />
        </div>
      </PageBand>

      <div className="grid items-start gap-[18px] @4xl:grid-cols-[minmax(0,1fr)_22rem] @6xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="@container/main flex min-w-0 flex-col gap-3.5">
          <BookingCard review={review} />
          <div
            role="group"
            aria-label="People this booking matched"
            className="grid items-start gap-3.5 @2xl/main:grid-cols-2"
          >
            {review.people.map((person) => (
              <PersonCard key={person.leadId} person={person} />
            ))}
          </div>
        </div>
        <aside aria-label="Decision" className="flex min-w-0 flex-col gap-3.5 @4xl:sticky @4xl:top-4">
          {open ? <DecidePanel review={review} booked={booked} matched={matched} /> : <ResolvedCard review={review} />}
        </aside>
      </div>
    </div>
  );
}

function Name({ children }: { children: React.ReactNode }) {
  return <strong className="font-medium text-board-foreground">{children}</strong>;
}

/** "Valentina R." ends its own sentence; anything else takes a period. */
function stop(name: string) {
  return name.endsWith(".") ? "" : ".";
}

function SummaryText({ review, booked, matched }: { review: Review; booked: Person | undefined; matched: Person[] }) {
  const invitee = review.booking.inviteeName ?? "Someone";
  // After "But" the first clause runs on in lower case; in the held summary each is its own sentence.
  const named = matched.map((person, index) => (
    <span key={person.leadId}>
      {" "}
      {review.kind === "attached" && booked && index === 0 ? "its" : "Its"}{" "}
      {person.matchedBy.map((via) => MATCH_LABELS[via]).join(" and ")} belongs to <Name>{personName(person)}</Name>
      {stop(personName(person))}
    </span>
  ));
  if (review.kind === "attached" && booked) {
    return (
      <p className="max-w-[75ch]">
        {invitee}&apos;s Instagram handle belongs to <Name>{personName(booked)}</Name>, so the call went to them. But
        {named} If they&apos;re the same person, merge them. If not, keep them separate: nothing moves.
      </p>
    );
  }
  return (
    <p className="max-w-[75ch]">
      The CRM is holding {invitee}&apos;s booking because its details name more than one person.
      {named.length ? named : null} The call isn&apos;t in the CRM until someone decides who it belongs to.
    </p>
  );
}
