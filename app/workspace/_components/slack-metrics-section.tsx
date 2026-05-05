"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { SlackMetricsSkeleton } from "./skeletons/slack-metrics-skeleton";
import { SlackConversionRatioCard } from "./slack-conversion-ratio-card";
import { SlackQualifiedTotalCard } from "./slack-qualified-total-card";
import { SlackUserLeaderboardCard } from "./slack-user-leaderboard-card";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export function SlackMetricsSection() {
  const [windowArgs] = useState(() => {
    const windowEnd = Date.now();
    return {
      windowStart: windowEnd - THIRTY_DAYS_MS,
      windowEnd,
    };
  });

  const conversion = useQuery(api.slack.metrics.conversionMetrics, windowArgs);
  const breakdown = useQuery(api.slack.metrics.perSlackUserBreakdown, windowArgs);
  const isLoading = conversion === undefined || breakdown === undefined;

  return (
    <section
      className="flex min-w-0 flex-col gap-3"
      aria-labelledby="slack-metrics-heading"
    >
      <div className="flex flex-col gap-1">
        <h2 id="slack-metrics-heading" className="text-lg font-semibold">
          Slack Conversion
        </h2>
        <p className="text-sm text-muted-foreground">
          Lead capture and booking conversion from{" "}
          <span translate="no">/qualify-lead</span>.
        </p>
      </div>
      {isLoading ? (
        <SlackMetricsSkeleton />
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
          <SlackQualifiedTotalCard metrics={conversion} />
          <SlackConversionRatioCard metrics={conversion} />
          <SlackUserLeaderboardCard breakdown={breakdown} />
        </div>
      )}
    </section>
  );
}
