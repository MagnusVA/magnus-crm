"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { format } from "date-fns";
import { CheckCircle2Icon, ChevronRightIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { usePageTitle } from "@/hooks/use-page-title";
import { BookingReviewsPageSkeleton } from "./booking-reviews-page-skeleton";
import { MATCH_LABELS } from "./booking-review-labels";

export function BookingReviewsPageClient() {
  usePageTitle("Booking Reviews");
  const reviews = useQuery(api.pipeline.bookingReviews.list, {});

  if (reviews === undefined) return <BookingReviewsPageSkeleton />;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Booking Reviews</h1>
        <p className="text-sm text-muted-foreground">
          Bookings whose email, phone or Instagram handle belong to more than
          one person. Decide whether they are the same person.
        </p>
      </div>

      {reviews.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CheckCircle2Icon />
            </EmptyMedia>
            <EmptyTitle>Nothing to review</EmptyTitle>
            <EmptyDescription>
              Every recent booking matched exactly one person.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Card className="py-0">
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Received</TableHead>
                  <TableHead>Booking</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Also matched</TableHead>
                  <TableHead className="pr-4 text-right">
                    <span className="sr-only">Open</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {reviews.map((review) => (
                  <TableRow key={review.reviewId}>
                    <TableCell className="pl-4 whitespace-nowrap text-muted-foreground">
                      {format(review.createdAt, "MMM d, h:mm a")}
                    </TableCell>
                    <TableCell className="font-medium">
                      {review.bookingName ?? "Unnamed invitee"}
                    </TableCell>
                    <TableCell>
                      {review.kind === "attached" ? (
                        <span className="flex flex-col gap-1">
                          <Badge variant="secondary">Booked by Instagram handle</Badge>
                          <span className="text-xs text-muted-foreground">
                            Went to {review.bookedLeadName ?? "an unnamed person"}
                          </span>
                        </span>
                      ) : (
                        <Badge variant="destructive">Held, not in the CRM</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="flex flex-col gap-1">
                        <span>{review.otherNames.join(", ") || "—"}</span>
                        <span className="text-xs text-muted-foreground">
                          by {review.matchedBy.map((via) => MATCH_LABELS[via]).join(", ") || "booking details"}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell className="pr-4 text-right">
                      <Button asChild variant="ghost" size="sm">
                        <Link href={`/workspace/operations/booking-reviews/${review.reviewId}`}>
                          Review
                          <ChevronRightIcon data-icon="inline-end" />
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
