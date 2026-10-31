"use client";

import { useMemo } from "react";
import type { Id } from "@/convex/_generated/dataModel";
import { useNow } from "@/hooks/use-now";
import {
  comparePersonDeals,
  openDealState,
  type PersonDeal,
} from "@/lib/person-page";
import {
  useEntityDetail,
  type EntityDetailMeeting,
  type EntityDetailOpportunity,
} from "./entity-detail-context";

export type PersonDealEntry = PersonDeal<EntityDetailOpportunity> & {
  /** The meeting behind the deal's next call, for "Record outcome". */
  callMeeting: EntityDetailMeeting | null;
};

export function isAdminViewer(role: string) {
  return role === "tenant_master" || role === "tenant_admin";
}

/**
 * The person's deals in card order, each open one with its step as of now.
 * A closer acts only on their own deals; an admin on any.
 */
export function usePersonDeals(): PersonDealEntry[] {
  const { opportunities, meetings, viewer } = useEntityDetail();
  const now = useNow();
  const admin = isAdminViewer(viewer.role);

  return useMemo(() => {
    const meetingsByDeal = new Map<Id<"opportunities">, EntityDetailMeeting[]>();
    for (const meeting of meetings) {
      const list = meetingsByDeal.get(meeting.opportunityId) ?? [];
      list.push(meeting);
      meetingsByDeal.set(meeting.opportunityId, list);
    }
    return opportunities
      .map((item): PersonDealEntry => {
        const { opportunity } = item;
        const outcome = opportunity.outcome;
        const callAt = item.nextStep?.callAt ?? opportunity.nextMeetingAt ?? null;
        const callMeeting =
          callAt === null
            ? null
            : (meetingsByDeal.get(opportunity._id)?.find((meeting) => meeting.scheduledAt === callAt) ??
              null);
        // An open deal always carries a step from the server; the fallback
        // covers a deployment that hasn't sent one yet.
        const nextStep =
          outcome === "open"
            ? (item.nextStep ?? { callAt, task: null, taskId: null, canSet: false })
            : null;
        return {
          item,
          outcome,
          createdAt: opportunity.createdAt,
          state: nextStep ? openDealState(nextStep, callMeeting, now) : null,
          canAct: admin || item.permissions.canOpenOpportunity,
          callMeeting,
        };
      })
      .sort(comparePersonDeals);
  }, [opportunities, meetings, admin, now]);
}
