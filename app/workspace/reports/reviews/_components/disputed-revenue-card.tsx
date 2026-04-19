"use client";

import { DollarSignIcon } from "lucide-react";
import { formatAmountMinor } from "@/lib/format-currency";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function DisputedRevenueCard({
  amountMinor,
  count,
  isTruncated,
}: {
  amountMinor: number;
  count: number;
  isTruncated: boolean;
}) {
  const formattedAmount = formatAmountMinor(amountMinor, "USD");

  return (
    <Card
      size="sm"
      className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-500"
    >
      <CardHeader>
        <CardAction>
          {isTruncated ? <Badge variant="outline">Capped</Badge> : null}
        </CardAction>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Disputed Revenue
          </CardTitle>
          <DollarSignIcon className="size-4 text-muted-foreground" aria-hidden />
        </div>
        <CardDescription>Disputed payment value in selected range.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        <div
          className="text-2xl font-semibold tracking-tight tabular-nums"
          aria-label={`${formattedAmount} across ${count.toLocaleString()} disputed payments`}
        >
          {formattedAmount}
        </div>
        <p className="text-xs text-muted-foreground">
          {count.toLocaleString()} disputed payment
          {count === 1 ? "" : "s"}
          {isTruncated ? " shown from the capped scan" : ""}
        </p>
      </CardContent>
    </Card>
  );
}
