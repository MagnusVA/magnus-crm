"use client";

import Link from "next/link";
import { useConvexAuth, usePaginatedQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ChevronRightIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { ROW_LINK } from "@/app/workspace/closer/pipeline/_components/deal-cells";
import { formatWholeNumber } from "@/app/workspace/_components/overview-formatters";
import { PageBand } from "@/app/workspace/_components/page-band";
import { CARD, HelpTip, LABEL } from "@/app/workspace/team/_components/team-ui";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import { usePageTitle } from "@/hooks/use-page-title";
import { cn } from "@/lib/utils";
import { BookingReviewsPageSkeleton } from "./booking-reviews-page-skeleton";
import { MATCH_LABELS } from "./booking-review-labels";
import { REVIEW_WORD_CLASS, ReviewStatusWord, receivedWords } from "./booking-review-ui";

// Open booking reviews, newest first, as one ruled card of 44px rows under
// the page band. Each row opens its review; below @3xl a row is two lines.

const PAGE_SIZE = 25;

type ReviewRow = FunctionReturnType<typeof api.pipeline.bookingReviews.list>["page"][number];

// RECEIVED · INVITEE · WENT TO · ALSO MATCHED · BY · STATUS · chevron.
const COLUMNS =
  "@3xl:grid @3xl:grid-cols-[8.5rem_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,0.9fr)_4.5rem_1rem]";

export function BookingReviewsPageClient() {
  usePageTitle("Booking Reviews");
  // The list throws without a signed-in caller, so it waits for the token
  // rather than racing it on a cold load.
  const { isAuthenticated } = useConvexAuth();
  const { results: reviews, status, loadMore } = usePaginatedQuery(
    api.pipeline.bookingReviews.list,
    isAuthenticated ? {} : "skip",
    { initialNumItems: PAGE_SIZE },
  );

  if (status === "LoadingFirstPage") return <BookingReviewsPageSkeleton />;

  const more = status === "CanLoadMore" || status === "LoadingMore";
  const held = reviews.filter((review) => review.kind === "held").length;
  const namesCapped = reviews.some((review) => review.namesCapped);

  return (
    <div className="@container mx-auto flex w-full max-w-[1500px] min-w-0 flex-col gap-3.5 pb-6 short:gap-3">
      <PageBand
        title="Booking Reviews"
        description="Bookings whose email, phone or Instagram handle match more than one person."
      />

      <section aria-labelledby="reviews-title" className={CARD}>
        <div className="flex min-h-11 flex-wrap items-baseline gap-x-2.5 gap-y-1 border-b border-border px-4 py-2.5">
          <h2 id="reviews-title" className="text-[15px] font-semibold">
            Open reviews
          </h2>
          <span className="text-[13px] text-muted-foreground">
            {reviews.length === 0 ? (
              "Newest first"
            ) : (
              <>
                <Figure>{formatWholeNumber(reviews.length)}</Figure>
                {more ? "+" : ""} open ·{" "}
                <HelpTip tip="The CRM is holding these bookings because their details name more than one person. The call isn't in the CRM until someone decides.">
                  <Figure className={held > 0 ? "text-danger-ink" : undefined}>{formatWholeNumber(held)}</Figure>
                  {more && held > 0 ? "+" : ""} held
                </HelpTip>
                {" · newest first"}
              </>
            )}
          </span>
        </div>

        {reviews.length === 0 ? (
          <SectionEmpty title="Nothing to review.">Every recent booking matched exactly one person.</SectionEmpty>
        ) : (
          <>
            <div className={cn("hidden min-h-7 items-end gap-3 border-b border-border px-4 pb-1.5", COLUMNS, LABEL)}>
              <span>Received</span>
              <span>Invitee</span>
              <span>
                <HelpTip tip="The person the booking was added to. A held booking isn't added to anyone until you decide.">
                  Went to
                </HelpTip>
              </span>
              <span>
                <HelpTip tip="Other people who share an email, phone or Instagram handle with the booking.">Also matched</HelpTip>
              </span>
              <span>
                <HelpTip tip="The booking details the other people share.">By</HelpTip>
              </span>
              <span>
                <HelpTip tip="HELD: the call is missing from the CRM until you decide. DECIDE: the call is in the CRM; only whether these are one person is open.">
                  Status
                </HelpTip>
              </span>
            </div>
            <ul aria-label="Open booking reviews">
              {reviews.map((review) => (
                <ReviewItem key={review.reviewId} review={review} />
              ))}
            </ul>
          </>
        )}

        {/* One footer line, only when it has something the head doesn't say. */}
        {reviews.length === 0 || (!more && !namesCapped) ? null : (
          <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-4 py-1.5 text-[13px] text-muted-foreground">
            <p role="status">
              {more ? `${formatWholeNumber(reviews.length)} shown` : null}
              {more && namesCapped ? ". " : null}
              {namesCapped ? (
                <>
                  <span className="font-medium text-foreground">Some names didn&apos;t load;</span> open a review to see
                  everyone it matched.
                </>
              ) : null}
            </p>
            {more ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="ml-auto h-7"
                disabled={status === "LoadingMore"}
                onClick={() => loadMore(PAGE_SIZE)}
              >
                {status === "LoadingMore" ? <Spinner data-icon="inline-start" /> : null}
                Show {PAGE_SIZE} more
              </Button>
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}

function Figure({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("font-condensed text-[14px] font-semibold text-foreground tabular-nums", className)}>{children}</span>;
}

function ReviewItem({ review }: { review: ReviewRow }) {
  const { setting } = useBusinessDay();
  const now = useNow();
  const received = receivedWords(review.createdAt, now, setting);
  const name = review.bookingName ?? "Unnamed invitee";
  const wentTo = review.kind === "attached" ? (review.bookedLeadName ?? "Unnamed person") : null;
  const others = review.otherNames.join(", ") || "—";
  const matchedBy = review.matchedBy.map((via) => MATCH_LABELS[via]).join(", ") || "booking details";

  return (
    <li className="relative border-b border-border transition-colors last:border-b-0 hover:bg-muted/60">
      <div className={cn("flex items-center gap-3 px-4 py-2 @3xl:h-[43px] @3xl:py-0", COLUMNS)}>
        <time
          dateTime={new Date(review.createdAt).toISOString()}
          className="hidden truncate font-condensed text-[15px] font-semibold tabular-nums @3xl:block"
        >
          {received}
        </time>
        <div className="min-w-0 flex-1">
          <Link
            href={`/workspace/operations/booking-reviews/${review.reviewId}`}
            className={cn(ROW_LINK, "block truncate font-semibold")}
          >
            {name}
          </Link>
          {/* Line 2 below @3xl */}
          <p className="truncate text-[13px] text-muted-foreground @3xl:hidden">
            <span className="font-condensed text-[14px] font-semibold text-foreground tabular-nums">{received} · </span>
            {wentTo ? `Went to ${wentTo} · ` : null}also {others}
          </p>
        </div>
        <p className="hidden truncate @3xl:block">{wentTo ?? <span className="text-muted-foreground">—</span>}</p>
        <p className="hidden truncate @3xl:block">{others}</p>
        <p className="hidden truncate text-[13px] text-muted-foreground @3xl:block">{matchedBy}</p>
        <ReviewStatusWord kind={review.kind} open className={REVIEW_WORD_CLASS} />
        <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      </div>
    </li>
  );
}
