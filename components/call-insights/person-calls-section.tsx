"use client";

import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { personDate } from "@/app/workspace/leads-customers/[leadId]/_components/person-format";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import { PersonCallsView } from "./person-calls-view";

/**
 * "From their calls" on the person page. This file holds the query;
 * `person-calls-view.tsx` draws the card. Renders nothing while loading, when
 * the viewer can't see it, or when no call was read yet.
 */
export function PersonCallsSection({ leadId }: { leadId: Id<"leads"> }) {
  const { isAuthenticated } = useConvexAuth();
  const data = useQuery(
    api.callInsights.queries.forPerson,
    isAuthenticated ? { leadId } : "skip",
  );
  const { setting } = useBusinessDay();
  const now = useNow();
  if (!data || data.callsRead === 0) return null;
  return (
    <PersonCallsView
      data={data}
      dateOf={(at) => personDate(at, setting, now)}
    />
  );
}
