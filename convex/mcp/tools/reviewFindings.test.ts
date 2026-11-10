import { afterEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { queueSecondOpinion } from "../../secondOpinion/trigger";
import { insertCloserMeeting } from "../../../tests/closerPipelineFixtures";
import { insertProgram } from "../../../tests/closerPipelineDeskFixtures";
import { callTool } from "../../../tests/mcpHarness";
import { mcpToolsFixture } from "../../../tests/mcpToolsFixtures";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type Fixture = Awaited<ReturnType<typeof mcpToolsFixture>>;

async function insertMatchedRecording(ctx: MutationCtx, f: Fixture, meetingId: Id<"meetings">, n: number) {
  const connectionId = await ctx.db.insert("tenantFathomConnections", {
    tenantId: f.tenantId,
    apiKey: "key",
    keyLast4: "abcd",
    triggeredFor: [],
    connectionStatus: "connected",
    connectedByUserId: f.ownerId,
    connectedAt: 0,
  });
  const now = Date.now();
  return await ctx.db.insert("callRecordings", {
    tenantId: f.tenantId,
    connectionId,
    recordedByUserId: f.closerId,
    recordedByEmail: "alex@northwind.example",
    meetingId,
    fathomRecordingId: n,
    url: "https://fathom.video/calls/x",
    shareUrl: "https://fathom.video/share/x",
    title: "Call",
    recordingStartAt: now - 40 * 60_000,
    recordingEndAt: now,
    // convex-test serves storage.store inside t.run; the mutation type lacks it.
    transcriptStorageId: await (ctx.storage as unknown as { store: (blob: Blob) => Promise<Id<"_storage">> }).store(
      new Blob(["[]"]),
    ),
    inviteeEmails: [],
    matchStatus: "matched",
    createdAt: now,
  });
}

describe("review round 1", () => {
  it("S1: hides a reassigned deal's notes and payments from the meeting's old closer", async () => {
    const f = await mcpToolsFixture();
    await f.t.run(async (ctx) => {
      await ctx.db.patch("meetings", f.meetingId, { scheduledAt: Date.now() - 30 * 60_000 });
      await ctx.db.patch("opportunities", f.dealId, { assignedCloserId: f.otherCloserId });
      await ctx.db.insert("callNotes", {
        tenantId: f.tenantId,
        opportunityId: f.dealId,
        authorUserId: f.otherCloserId,
        currentSituation: "secret",
        goal: "secret",
        bottleneck: "secret",
        objection: "the new closer's private note",
        agentClient: "claude-ai",
        contentHash: "x",
        createdAt: Date.now(),
      });
    });
    const today = await callTool(f.t, f.token, f.sessionId, "magnus_today");
    expect(JSON.stringify(today.data)).not.toContain("the new closer's private note");
  });

  it("S2: magnus_today and magnus_person give payment IDs and proof status", async () => {
    const f = await mcpToolsFixture();
    const programId = await f.t.run((ctx) => insertProgram(ctx, f.tenantId, f.ownerId, "Scale Program"));
    const paymentId = await f.t.run(async (ctx) => {
      await ctx.db.patch("meetings", f.meetingId, { scheduledAt: Date.now() - 30 * 60_000 });
      return await ctx.db.insert("paymentRecords", {
        tenantId: f.tenantId,
        opportunityId: f.dealId,
        attributedCloserId: f.closerId,
        amountMinor: 120000,
        currency: "USD",
        recordedByUserId: f.ownerId,
        programId,
        programName: "Scale Program",
        paymentType: "split",
        status: "recorded",
        recordedAt: Date.now(),
        origin: "admin_meeting",
      });
    });
    const today = await callTool(f.t, f.token, f.sessionId, "magnus_today");
    const meeting = (today.data as { meetings: Array<{ payments: unknown[] }> }).meetings[0];
    expect(meeting.payments).toEqual([expect.objectContaining({ paymentId, hasProof: false })]);
    const person = await callTool(f.t, f.token, f.sessionId, "magnus_person", { meetingId: f.meetingId });
    expect(JSON.stringify(person.data)).toContain(paymentId);
  });

  it("S3: checks the result recorded for this meeting, not a later call's payment", async () => {
    const f = await mcpToolsFixture();
    const programId = await f.t.run((ctx) => insertProgram(ctx, f.tenantId, f.ownerId, "Scale Program"));
    const opinionId = await f.t.run(async (ctx) => {
      await ctx.db.patch("tenants", f.tenantId, {
        secondOpinion: { mode: "shadow", monthlyCapUsd: 40, changedAt: 0, changedByUserId: f.ownerId },
      });
      const now = Date.now();
      // The first call ended in a call-back...
      await ctx.db.patch("meetings", f.meetingId, { status: "held", heldMarkedAt: now - 3_600_000 });
      await ctx.db.insert("followUps", {
        tenantId: f.tenantId,
        opportunityId: f.dealId,
        leadId: f.leadId,
        closerId: f.closerId,
        type: "manual_reminder",
        sourceMeetingId: f.meetingId,
        reminderScheduledAt: now + 3_600_000,
        reason: "closer_initiated",
        status: "completed",
        createdAt: now - 3_600_000,
      });
      // ...and a later call on the same deal was paid.
      const later = await insertCloserMeeting(ctx, {
        tenantId: f.tenantId,
        opportunityId: f.dealId,
        closerId: f.closerId,
        status: "held",
        scheduledAt: now - 600_000,
      });
      await ctx.db.insert("paymentRecords", {
        tenantId: f.tenantId,
        opportunityId: f.dealId,
        meetingId: later,
        attributedCloserId: f.closerId,
        amountMinor: 450000,
        currency: "USD",
        recordedByUserId: f.closerId,
        programId,
        programName: "Scale Program",
        paymentType: "pif",
        status: "recorded",
        recordedAt: now,
        origin: "closer_meeting",
      });
      // The first call's recording arrives only now.
      await insertMatchedRecording(ctx, f, f.meetingId, 7);
      return await queueSecondOpinion(ctx, { meetingId: f.meetingId, trigger: "recording_matched" });
    });
    const opinion = await f.t.run((ctx) => ctx.db.get("secondOpinions", opinionId!));
    expect(opinion?.record).toEqual({ kind: "call_back" });
  });

  it("S4: the day summary lists an open disagreement as a gap in on mode", async () => {
    const f = await mcpToolsFixture();
    await f.t.run(async (ctx) => {
      await ctx.db.patch("tenants", f.tenantId, {
        secondOpinion: { mode: "on", monthlyCapUsd: 40, changedAt: 0, changedByUserId: f.ownerId },
      });
      await ctx.db.patch("meetings", f.meetingId, { status: "no_show" });
      const recordingId = await insertMatchedRecording(ctx, f, f.meetingId, 8);
      await ctx.db.insert("secondOpinions", {
        tenantId: f.tenantId,
        meetingId: f.meetingId,
        recordingId,
        closerUserId: f.closerId,
        trigger: "recording_matched",
        record: { kind: "no_show" },
        inputKey: `${f.meetingId}:${recordingId}`,
        model: "typesafe/jev-1.13",
        status: "answered",
        attempts: 1,
        verdict: "disagrees",
        reviewState: "open",
        createdAt: Date.now(),
      });
    });
    // Fifty newer disagreements of another closer's must not hide the caller's.
    await f.t.run(async (ctx) => {
      const recordingId = await insertMatchedRecording(ctx, f, f.otherMeetingId, 9);
      for (let i = 0; i < 50; i++) {
        await ctx.db.insert("secondOpinions", {
          tenantId: f.tenantId,
          meetingId: f.otherMeetingId,
          recordingId,
          closerUserId: f.otherCloserId,
          trigger: "recording_matched",
          inputKey: `other:${i}`,
          model: "typesafe/jev-1.13",
          status: "answered",
          attempts: 1,
          verdict: "disagrees",
          reviewState: "open",
          createdAt: Date.now() + 1000 + i,
        });
      }
    });
    const summary = await callTool(f.t, f.token, f.sessionId, "magnus_day_summary");
    const gaps = (summary.data as { gaps: Array<{ kind: string }> }).gaps;
    expect(gaps.filter((gap) => gap.kind === "second_opinion")).toHaveLength(1);
  });
});
