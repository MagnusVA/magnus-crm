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
import { CompareCard, dayAndClock, personName, type Person, type Review } from "./booking-review-compare";
import { DecidePanel, ResolvedCard } from "./booking-review-decide";

// One booking review: the band says what happened in a sentence, the main
// column compares the booking with the people it matched, and the rail
// holds the decision.

const BACK = { href: "/workspace/operations/booking-reviews", label: "Booking Reviews" };
const COUNT_WORDS = ["", "one", "two", "three", "four", "five"];

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
  const { booking } = review;
  const subtitle = [
    `Received ${dayAndClock(review.createdAt, setting, now)}`,
    booking.startTime !== undefined ? `Call ${dayAndClock(booking.startTime, setting, now)}` : null,
    booking.eventName ?? null,
  ].filter(Boolean);

  return (
    <div className="@container mx-auto flex w-full max-w-[1500px] min-w-0 flex-col gap-3.5 pb-6 short:gap-3">
      <PageBand
        back={BACK}
        title={
          review.kind === "attached"
            ? `Booking matched ${COUNT_WORDS[review.people.length] ?? review.people.length} people`
            : "Booking held for review"
        }
        description={subtitle.join(" · ")}
        actions={
          <ReviewStatusWord
            kind={review.kind}
            open={open}
            className={cn(REVIEW_WORD_CLASS, "text-[17px]", !open && "text-board-muted")}
          />
        }
      >
        <p className="-mt-1.5 max-w-[100ch] pb-3.5 text-[14px] text-board-foreground/80 @lg:pb-4">
          <Summary review={review} booked={booked} matched={matched} open={open} />
        </p>
      </PageBand>

      <div className="grid items-start gap-[18px] @4xl:grid-cols-[minmax(0,1fr)_20rem] @6xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="flex min-w-0 flex-col gap-3.5">
          <CompareCard review={review} />
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

/**
 * One or two short sentences: whose each detail is. A person already merged
 * into someone on the page isn't named again.
 */
function Summary({
  review,
  booked,
  matched,
  open,
}: {
  review: Review;
  booked: Person | undefined;
  matched: Person[];
  open: boolean;
}) {
  const onPage = new Set(review.people.map((person) => person.leadId));
  const named = matched.filter(
    (person) => !(person.status === "merged" && person.mergedIntoLeadId && onPage.has(person.mergedIntoLeadId)),
  );
  // After "but" the list runs on in lower case; the held sentence opens with it.
  const opensSentence = !(review.kind === "attached" && booked);
  const clauses = named.map((person, index) => {
    const what = person.matchedBy.map((via) => MATCH_LABELS[via]).join(" and ");
    const last = index === named.length - 1;
    return (
      <span key={person.leadId}>
        {index === 0 ? null : last ? " and " : ", "}
        {index === 0 ? `${opensSentence ? "Its" : "its"} ${what} belongs to ` : `its ${what} to `}
        <Name>{personName(person)}</Name>
        {last ? stop(personName(person)) : null}
      </span>
    );
  });

  if (!opensSentence && booked) {
    return (
      <>
        The call went to <Name>{personName(booked)}</Name> by Instagram handle
        {clauses.length ? <>, but {clauses}</> : "."}
      </>
    );
  }
  return (
    <>
      {clauses.length ? clauses : "Its details name more than one person."}
      {open ? " The call stays out of the CRM until you decide." : null}
    </>
  );
}
