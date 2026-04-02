"use client";

import { StatsCard } from "./stats-card";
import { UsersIcon, TrendingUpIcon, CalendarIcon, TrophyIcon } from "lucide-react";

interface Stats {
  totalClosers: number;
  unmatchedClosers: number;
  totalTeamMembers: number;
  activeOpportunities: number;
  meetingsToday: number;
  wonDeals: number;
  totalOpportunities: number;
  revenueLogged?: number;
  paymentRecordsLogged?: number;
}

interface StatsRowProps {
  stats: Stats;
}

export function StatsRow({ stats }: StatsRowProps) {
  const activePercent =
    stats.totalOpportunities > 0
      ? Math.round(
          (stats.activeOpportunities / stats.totalOpportunities) * 100,
        )
      : 0;

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
      <StatsCard
        icon={UsersIcon}
        label="Total Closers"
        value={stats.totalClosers}
        subtext={
          stats.unmatchedClosers > 0
            ? `${stats.unmatchedClosers} unmatched`
            : "All matched"
        }
        variant={stats.unmatchedClosers > 0 ? "warning" : "default"}
      />

      <StatsCard
        icon={TrendingUpIcon}
        label="Active Opportunities"
        value={stats.activeOpportunities}
        subtext={`${activePercent}% of ${stats.totalOpportunities} total`}
      />

      <StatsCard
        icon={CalendarIcon}
        label="Meetings Today"
        value={stats.meetingsToday}
        subtext={stats.meetingsToday > 0 ? "Scheduled" : "No meetings"}
      />

      <StatsCard
        icon={TrophyIcon}
        label="Won Deals"
        value={stats.wonDeals}
        subtext="Payments received"
        variant="success"
      />
    </div>
  );
}
