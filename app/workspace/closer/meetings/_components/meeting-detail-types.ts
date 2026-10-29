import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";

/** What `getMeetingDetail` returns for a meeting the viewer can open. */
export type MeetingDetail = NonNullable<
  FunctionReturnType<typeof api.closer.meetingDetail.getMeetingDetail>
>;

/**
 * Which side of the page is rendering: the closer's page, or the admin twin
 * at `/workspace/pipeline/meetings/[meetingId]`, whose actions call the
 * admin mutations on the assigned closer's behalf.
 */
export type MeetingDetailMode = "closer" | "admin";

/** The first word of the person's name, for questions like "Did Ana show up?". */
export function firstNameOf(fullName: string | undefined | null): string | null {
  const first = fullName?.trim().split(/\s+/)[0];
  return first ? first : null;
}
