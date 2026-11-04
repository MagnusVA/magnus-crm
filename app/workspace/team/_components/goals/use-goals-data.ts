"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { last30DaysRange } from "./goal-model";

/**
 * What Team › Goals and its band read: the directory (each record's week,
 * each team's booked goal) and the last 30 finished days of the
 * Qualifications and Booked Calls dashboards (rates per hour, and the
 * qualified-leads goal). The band and the page call this with the same
 * arguments, so Convex runs each query once.
 */
export function useGoalsData() {
  const directory = useQuery(api.team.directory.getDirectory, {});
  const range = directory ? last30DaysRange(directory.today) : null;
  const qualifications = useQuery(
    api.operations.qualificationsDashboard.getQualificationsDashboard,
    range ? { range } : "skip",
  );
  const booked = useQuery(api.operations.bookedCallsDashboard.getBookedCallsDashboard, range ? { range } : "skip");
  return { directory, qualifications, booked };
}
