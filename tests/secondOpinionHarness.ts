import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { convexTestModules } from "../convex/test.setup";
import { registerComponents, qualifiedLifecycle } from "./bookingHarness";
import type { Doc } from "../convex/_generated/dataModel";
import { queueSecondOpinion } from "../convex/secondOpinion/trigger";

export async function secondOpinionHarness(
  mode: "off" | "shadow" | "on" | null = "on",
  status: Doc<"meetings">["status"] = "no_show",
) {
  const t = convexTest({ schema, modules: convexTestModules });
  registerComponents(t);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const tenantId = await ctx.db.insert("tenants", {
      companyName: "Test",
      contactEmail: "owner@example.com",
      workosOrgId: "org_test",
      status: "active",
      inviteExpiresAt: 0,
      createdBy: "test",
    });
    const ownerId = await ctx.db.insert("users", {
      tenantId,
      workosUserId: "user_owner",
      email: "owner@example.com",
      fullName: "Morgan",
      role: "tenant_master",
      isActive: true,
    });
    const adminId = await ctx.db.insert("users", {
      tenantId,
      workosUserId: "user_admin",
      email: "admin@example.com",
      fullName: "Jordan",
      role: "tenant_admin",
      isActive: true,
    });
    const closerId = await ctx.db.insert("users", {
      tenantId,
      workosUserId: "user_closer",
      email: "kim@example.com",
      fullName: "Kim",
      role: "closer",
      timezone: "America/Tegucigalpa",
      isActive: true,
    });
    const otherId = await ctx.db.insert("users", {
      tenantId,
      workosUserId: "user_other",
      email: "other@example.com",
      role: "closer",
      isActive: true,
    });
    if (mode)
      await ctx.db.patch("tenants", tenantId, {
        secondOpinion: {
          mode,
          monthlyCapUsd: 40,
          shadowUntil: now + 14 * 86400_000,
          changedAt: now,
          changedByUserId: ownerId,
        },
      });
    const leadId = await ctx.db.insert("leads", {
      tenantId,
      email: "grace@example.com",
      fullName: "Grace",
      status: "active",
      firstSeenAt: now,
      updatedAt: now,
      ...qualifiedLifecycle(now),
    });
    const opportunityId = await ctx.db.insert("opportunities", {
      tenantId,
      leadId,
      assignedCloserId: closerId,
      stage:
        status === "no_show"
          ? "closed"
          : status === "held"
            ? "follow_up"
            : "booked",
      outcome: status === "no_show" ? "lost" : "open",
      ...(status === "no_show" ? { lostReason: "no_show", lostAt: now } : {}),
      createdAt: now,
      updatedAt: now,
    });
    const meetingId = await ctx.db.insert("meetings", {
      tenantId,
      opportunityId,
      assignedCloserId: closerId,
      calendlyEventUri: "event",
      calendlyInviteeUri: "invitee",
      scheduledAt: now - 2 * 3600_000,
      durationMinutes: 34,
      status,
      leadName: "Grace",
      bookingProgramName: "Scale Program",
      createdAt: now,
      ...(status === "held" ? { heldMarkedAt: now } : {}),
    });
    const connectionId = await ctx.db.insert("tenantFathomConnections", {
      tenantId,
      apiKey: "test",
      keyLast4: "test",
      webhookSecret: "test",
      webhookId: "test",
      connectionStatus: "connected",
      triggeredFor: [],
      connectedByUserId: ownerId,
      connectedAt: now,
    });
    const transcriptStorageId = await ctx.storage.store(
      new Blob(
        [
          JSON.stringify([
            { speaker: "Kim", timestamp: "00:00:05", text: "Hello." },
            {
              speaker: "Grace",
              email: "grace@example.com",
              timestamp: "00:11:00",
              text: "Sorry I'm late. Could we talk tomorrow?",
            },
            {
              speaker: "Kim",
              email: "kim@example.com",
              timestamp: "00:11:45",
              text: "Yes.",
            },
            {
              speaker: "Support",
              email: "staff@example.com",
              timestamp: "00:12:00",
              text: "Bye.",
            },
          ]),
        ],
        { type: "application/json" },
      ),
    );
    const recordingId = await ctx.db.insert("callRecordings", {
      tenantId,
      connectionId,
      recordedByUserId: closerId,
      recordedByEmail: "kim@example.com",
      fathomRecordingId: 1,
      title: "Grace",
      url: "https://fathom.video/calls/1",
      shareUrl: "https://fathom.video/share/1",
      recordingStartAt: now - 2 * 3600_000,
      recordingEndAt: now - 2 * 3600_000 + 34 * 60_000,
      inviteeEmails: ["grace@example.com"],
      meetingId,
      transcriptStorageId,
      transcriptLineCount: 4,
      summaryMarkdown: "Grace asked to talk again.",
      actionItems: [{ description: "Call tomorrow" }],
      matchStatus: "matched",
      createdAt: now,
    });
    return {
      tenantId,
      ownerId,
      adminId,
      closerId,
      otherId,
      leadId,
      opportunityId,
      meetingId,
      recordingId,
      transcriptStorageId,
    };
  });
  return {
    t,
    ...ids,
    owner: t.withIdentity({ subject: "user_owner", org_id: "org_test" }),
    admin: t.withIdentity({ subject: "user_admin", org_id: "org_test" }),
    closer: t.withIdentity({ subject: "user_closer", org_id: "org_test" }),
    other: t.withIdentity({ subject: "user_other", org_id: "org_test" }),
    patchDeal: (fields: Partial<Doc<"opportunities">>) =>
      t.run((ctx) => ctx.db.patch("opportunities", ids.opportunityId, fields)),
    queue: (
      trigger:
        | "result_recorded"
        | "recording_matched"
        | "day_closed" = "result_recorded",
    ) =>
      t.run((ctx) =>
        queueSecondOpinion(ctx, { meetingId: ids.meetingId, trigger }),
      ),
  };
}
export const decisionsResponse = () => ({
  id: "gateway-test",
  model: "typesafe/jev-1.13",
  answers: {
    attendance: { choice: "held", confidence: 0.96 },
    ending: { choice: "call_back", confidence: 0.81 },
    objection: { choice: "partner", confidence: 0.71 },
    claim: { noul: 0.03 },
  },
  usage: { input_tokens: 8210, output_tokens: 12, cost: 0.0187 },
});
