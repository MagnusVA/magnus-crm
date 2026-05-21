"use client";

import type { FunctionReturnType } from "convex/server";
import Link from "next/link";
import { TrophyIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

type UserBreakdown = FunctionReturnType<
  typeof api.slack.metrics.perSlackUserBreakdown
>;

export function SlackUserLeaderboardCard({
  breakdown,
}: {
  breakdown: UserBreakdown;
}) {
  const rows = breakdown.rows.slice(0, 5);

  return (
    <Card size="sm" className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TrophyIcon className="size-4 text-muted-foreground" aria-hidden />
          Top Qualifiers
        </CardTitle>
        <CardDescription>Slack users by qualification events</CardDescription>
        <CardAction className="flex items-center gap-2">
          <Badge variant={breakdown.truncated ? "destructive" : "outline"}>
            {breakdown.truncated ? "Partial" : "Top 5"}
          </Badge>
          <Button asChild variant="ghost" size="sm">
            <Link href="/workspace/reports/slack-qualifications">Details</Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No Slack qualifications yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-3" aria-label="Top Slack qualifiers">
            {rows.map((row) => {
              const label = row.displayName ?? row.slackUserId;
              const displayLabel = row.isDeleted
                ? `${label} (deactivated)`
                : label;
              const percent =
                row.ratio === null ? 0 : Math.round(row.ratio * 100);

              return (
                <li
                  key={row.slackUserId}
                  className="grid grid-cols-[auto_1fr_auto] items-center gap-3"
                >
                  <Avatar size="sm">
                    <AvatarImage
                      src={row.avatarUrl ?? undefined}
                      alt=""
                      width={24}
                      height={24}
                    />
                    <AvatarFallback>
                      {label.slice(0, 1).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium">
                        {displayLabel}
                      </p>
                    </div>
                    <Progress
                      className="mt-1"
                      value={percent}
                      aria-label={`${displayLabel}: ${percent}% conversion rate`}
                    />
                  </div>
                  <div className="text-right">
                    <p className="font-mono text-sm font-semibold tabular-nums">
                      {row.total}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {row.uniqueOpportunityCount} opps / {row.booked} booked
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
