import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { isPlaceholderEmail, normalizeEmail } from "../lib/normalization";

/** Matching only reads meetings and existing real identifiers. It never resolves or writes identity. */
export async function matchRecording(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    userId: Id<"users">;
    recordingStartAt: number;
    inviteeEmails: string[];
    meetingUrl?: string;
  },
) {
  const candidates = await ctx.db
    .query("meetings")
    .withIndex("by_tenantId_and_assignedCloserId_and_scheduledAt", (q) =>
      q
        .eq("tenantId", args.tenantId)
        .eq("assignedCloserId", args.userId)
        .gte("scheduledAt", args.recordingStartAt - 30 * 60_000)
        .lte("scheduledAt", args.recordingStartAt + 30 * 60_000),
    )
    .take(101);
  if (candidates.length === 0 || candidates.length > 100) return null;
  if (candidates.length === 1)
    return { meetingId: candidates[0]._id, matchMethod: "time_only" as const };
  if (args.inviteeEmails.length > 100) return null;
  const emails = new Set(
    args.inviteeEmails
      .map(normalizeEmail)
      .filter((e): e is string => Boolean(e) && !isPlaceholderEmail(e!)),
  );
  const emailLeadIds = new Set<Id<"leads">>();
  for (const email of emails) {
    const identifiers = await ctx.db
      .query("leadIdentifiers")
      .withIndex("by_tenantId_and_type_and_value", (q) =>
        q.eq("tenantId", args.tenantId).eq("type", "email").eq("value", email),
      )
      .take(21);
    // An overfull identifier lookup is ambiguous; don't choose from a truncated set.
    if (identifiers.length > 20) return null;
    for (const i of identifiers)
      if (i.confidence !== "suggested") emailLeadIds.add(i.leadId);
  }
  const recordingUrl = normalizeJoinUrl(args.meetingUrl);
  const matches: {
    meetingId: Id<"meetings">;
    matchMethod: "time_email" | "time_url";
  }[] = [];
  for (const m of candidates) {
    const opportunity = await ctx.db.get("opportunities", m.opportunityId);
    const emailMatch =
      opportunity?.tenantId === args.tenantId &&
      emailLeadIds.has(opportunity.leadId);
    const urlMatch =
      recordingUrl !== null &&
      recordingUrl === normalizeJoinUrl(m.meetingJoinUrl ?? m.zoomJoinUrl);
    if (emailMatch || urlMatch)
      matches.push({
        meetingId: m._id,
        matchMethod: emailMatch ? "time_email" : "time_url",
      });
  }
  return matches.length === 1 ? matches[0] : null;
}
function normalizeJoinUrl(value?: string) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return `${url.hostname.toLowerCase()}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return null;
  }
}
