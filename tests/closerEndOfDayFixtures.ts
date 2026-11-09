import {
  closerPipelineHarness,
  insertCloserDeal,
  insertCloserMeeting,
} from "./closerPipelineFixtures";
import { meetingsByStatus } from "../convex/reporting/aggregates";
import type { Doc, Id } from "../convex/_generated/dataModel";
import type { MutationCtx } from "../convex/_generated/server";

export const EOD_NOW = Date.UTC(2026, 10, 3, 23);
export const EOD_DAY = 86_400_000;
export const EOD_HOUR = 3_600_000;

export async function endOfDayHarness(slack = false) {
  const harness = await closerPipelineHarness();
  const ids = await harness.t.run(async (ctx) => {
    await ctx.db.patch("users", harness.closerId, { fullName: "Ana Reyes" });
    const programId = await ctx.db.insert("tenantPrograms", {
      tenantId: harness.tenantId,
      name: "Scale Program",
      normalizedName: "scale program",
      createdAt: 0,
      updatedAt: 0,
      createdByUserId: harness.closerId,
    });
    const connectionId = await ctx.db.insert("tenantFathomConnections", {
      tenantId: harness.tenantId,
      apiKey: "test",
      keyLast4: "test",
      triggeredFor: [],
      connectionStatus: "connected",
      connectedByUserId: harness.closerId,
      connectedAt: 0,
    });
    const installationId = slack
      ? await ctx.db.insert("slackInstallations", {
          tenantId: harness.tenantId,
          teamId: "T1",
          teamName: "Team",
          isEnterpriseInstall: false,
          appId: "A1",
          botUserId: "B1",
          botAccessToken: "fake-test-token",
          scopes: [],
          notifyChannelId: "C_OTHER",
          eodReportChannelId: "C_EOD",
          eodReportChannelName: "sales-eod",
          installedByWorkosUserId: "user_admin",
          installedAt: 0,
          tokenExpiresAt: EOD_NOW + 7 * EOD_DAY,
          refreshToken: "fake",
          status: "active",
        })
      : null;
    return { programId, connectionId, installationId };
  });
  return { ...harness, ...ids };
}

export type EodHarness = Awaited<ReturnType<typeof endOfDayHarness>>;

export async function eodCall(
  ctx: MutationCtx,
  h: EodHarness,
  options: {
    status: Doc<"meetings">["status"];
    dealStatus: Parameters<typeof insertCloserDeal>[1]["status"];
    at?: number;
    callType?: "new" | "follow_up";
    name?: string;
  },
) {
  const opportunityId = await insertCloserDeal(ctx, {
    tenantId: h.tenantId,
    closerId: h.closerId,
    status: options.dealStatus,
    createdAt: 0,
    fields: {
      firstBookingProgramName: "Scale Program",
      ...(["no_show", "canceled"].includes(options.dealStatus) && {
        lostReason: options.dealStatus,
      }),
      ...(options.dealStatus === "lost" && {
        lostByUserId: h.closerId,
        lostReason: "Sensitive reason never shared",
      }),
    },
  });
  const deal = (await ctx.db.get("opportunities", opportunityId))!;
  await ctx.db.patch("leads", deal.leadId, {
    fullName: options.name ?? "Marcus Tate",
  });
  const meetingId = await insertCloserMeeting(ctx, {
    tenantId: h.tenantId,
    closerId: h.closerId,
    opportunityId,
    status: options.status,
    scheduledAt: options.at ?? EOD_NOW - EOD_HOUR,
  });
  await ctx.db.patch("meetings", meetingId, {
    callClassification: options.callType ?? "new",
    leadName: options.name ?? "Marcus Tate",
  });
  await meetingsByStatus.insert(
    ctx,
    (await ctx.db.get("meetings", meetingId))!,
  );
  return { meetingId, opportunityId, leadId: deal.leadId };
}

export async function eodPayment(
  ctx: MutationCtx,
  h: EodHarness,
  opportunityId: Id<"opportunities">,
  options: {
    amountMinor: number;
    paymentType?: Doc<"paymentRecords">["paymentType"];
    currency?: string;
    recordedAt?: number;
    status?: Doc<"paymentRecords">["status"];
  },
) {
  return ctx.db.insert("paymentRecords", {
    tenantId: h.tenantId,
    opportunityId,
    attributedCloserId: h.closerId,
    recordedByUserId: h.closerId,
    programId: h.programId,
    programName: "Scale Program",
    amountMinor: options.amountMinor,
    paymentType: options.paymentType ?? "pif",
    currency: options.currency ?? "USD",
    recordedAt: options.recordedAt ?? EOD_NOW - 1000,
    status: options.status ?? "recorded",
    origin: "closer_meeting",
  });
}

export async function eodRecording(
  ctx: MutationCtx,
  h: EodHarness,
  options: {
    meetingId?: Id<"meetings">;
    endedAt?: number;
    recordingId: number;
    userId?: Id<"users">;
  },
) {
  return ctx.db.insert("callRecordings", {
    tenantId: h.tenantId,
    connectionId: h.connectionId,
    recordedByUserId: options.userId ?? h.closerId,
    recordedByEmail: "recorder@example.test",
    meetingId: options.meetingId,
    fathomRecordingId: options.recordingId,
    url: "https://fathom.video/test",
    shareUrl: "https://fathom.video/share/test",
    title: "Private title",
    inviteeEmails: [],
    recordingStartAt: EOD_NOW - EOD_HOUR,
    recordingEndAt: options.endedAt ?? EOD_NOW - 1000,
    createdAt: EOD_NOW,
    matchStatus: options.meetingId ? "matched" : "unmatched",
  });
}
