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

// Open booking reviews, newest first, as one ruled card under the page band.
// Each row opens its review.

const PAGE_SIZE = 25;

type ReviewRow = FunctionReturnType<typeof api.pipeline.bookingReviews.list>["page"][number];

const COLUMNS = "@3xl:grid @3xl:grid-cols-[7.5rem_minmax(0,1.3fr)_minmax(0,1fr)_4.5rem_1rem]";

const FIGURE_LABEL = "font-condensed text-[11px] font-semibold tracking-[0.14em] text-board-muted uppercase";
const FIGURE = "font-condensed text-[30px] leading-[1.05] font-semibold tabular-nums";
const PROOF = "text-[13px] text-board-foreground/75";

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

  return (
    <div className="@container mx-auto flex w-full max-w-[1500px] min-w-0 flex-col gap-3.5 pb-6 short:gap-3">
      <PageBand
        title="Booking Reviews"
        description="Bookings whose email, phone or Instagram handle belong to more than one person. Decide whether they're the same person."
      >
        <div
          role="group"
          aria-label="Review figures"
          className="-mx-4 grid grid-cols-2 gap-px border-t border-board-line bg-board-line @lg:-mx-[18px] @3xl:grid-cols-[minmax(0,16rem)_minmax(0,16rem)_1fr]"
        >
          <div className="flex min-w-0 flex-col gap-1 bg-board px-4 py-3 @lg:px-[18px] @lg:pb-3.5">
            <p className={FIGURE_LABEL}>
              <HelpTip tip="Open reviews loaded on this page. Each one waits for an admin to decide.">To review</HelpTip>
            </p>
            <p className={FIGURE}>
              {formatWholeNumber(reviews.length)}
              {more ? "+" : ""}
            </p>
            <p className={PROOF}>
              {reviews.length === 0 ? "Nothing waiting" : more ? "Newest first; more below" : "Newest first"}
            </p>
          </div>
          <div className="flex min-w-0 flex-col gap-1 bg-board px-4 py-3 @lg:px-[18px] @lg:pb-3.5">
            <p className={FIGURE_LABEL}>
              <HelpTip tip="Bookings the CRM is holding because their details name more than one person. The call isn't in the CRM until someone decides.">
                Held
              </HelpTip>
            </p>
            <p className={cn(FIGURE, held > 0 && "text-board-danger")}>
              {formatWholeNumber(held)}
              {more && held > 0 ? "+" : ""}
            </p>
            <p className={PROOF}>{held === 0 ? "Every call is in the CRM" : `Call${held === 1 ? "" : "s"} not in the CRM yet`}</p>
          </div>
          <div className="hidden bg-board @3xl:block" />
        </div>
      </PageBand>

      <section aria-labelledby="reviews-title" className={CARD}>
        <div className="flex min-h-11 items-center gap-2.5 border-b border-border px-4 py-2">
          <h2 id="reviews-title" className="text-[15px] font-semibold">
            Open reviews
          </h2>
          <span className="text-[13px] text-muted-foreground">Newest first</span>
        </div>

        {reviews.length === 0 ? (
          <SectionEmpty title="Nothing to review.">Every recent booking matched exactly one person.</SectionEmpty>
        ) : (
          <>
            <div className={cn("hidden min-h-7 items-end gap-3 border-b border-border px-4 pb-1.5", COLUMNS, LABEL)}>
              <span>Received</span>
              <span>Booking</span>
              <span>
                <HelpTip tip="Other people who share an email, phone or Instagram handle with the booking.">Also matched</HelpTip>
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
            {reviews.some((review) => review.namesCapped) ? (
              <p role="status" className="border-t border-border px-4 py-2.5 text-[13px] text-muted-foreground">
                <span className="font-medium text-foreground">Some names didn&apos;t load.</span> Open a review to see
                everyone it matched.
              </p>
            ) : null}
          </>
        )}

        {reviews.length === 0 ? null : (
          <div className="flex min-h-10 items-center gap-3 border-t border-border px-4 py-1.5 text-[13px] text-muted-foreground">
            <span role="status">
              {formatWholeNumber(reviews.length)} {reviews.length === 1 ? "review" : "reviews"}
              {more ? " shown" : ""}
            </span>
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

function ReviewItem({ review }: { review: ReviewRow }) {
  const { setting } = useBusinessDay();
  const now = useNow();
  const received = receivedWords(review.createdAt, now, setting);
  const name = review.bookingName ?? "Unnamed invitee";
  const outcome =
    review.kind === "attached"
      ? `Went to ${review.bookedLeadName ?? "an unnamed person"} by Instagram handle`
      : "Not in the CRM yet";
  const others = review.otherNames.join(", ") || "—";
  const matchedBy = `by ${review.matchedBy.map((via) => MATCH_LABELS[via]).join(", ") || "booking details"}`;

  return (
    <li className="relative border-b border-border transition-colors last:border-b-0 hover:bg-muted/60">
      <div className={cn("flex items-center gap-3 px-4 py-2 @3xl:min-h-12 @3xl:py-1.5", COLUMNS, "@3xl:items-center")}>
        <time
          dateTime={new Date(review.createdAt).toISOString()}
          className="hidden font-condensed text-[15px] font-semibold tabular-nums @3xl:block"
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
          <p className="truncate text-[13px] text-muted-foreground">
            <span className="font-condensed text-[14px] font-semibold text-foreground tabular-nums @3xl:hidden">{received} · </span>
            <span className="@3xl:hidden">{review.kind === "held" ? "Not in the CRM yet" : `Went to ${review.bookedLeadName ?? "an unnamed person"}`} · also {others}</span>
            <span className="hidden @3xl:inline">{outcome}</span>
          </p>
        </div>
        <div className="hidden min-w-0 @3xl:block">
          <p className="truncate">{others}</p>
          <p className="truncate text-[13px] text-muted-foreground">{matchedBy}</p>
        </div>
        <ReviewStatusWord kind={review.kind} open className={REVIEW_WORD_CLASS} />
        <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      </div>
    </li>
  );
}
