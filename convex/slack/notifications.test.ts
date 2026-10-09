import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  buildLeadGenSubmissionNotification,
  buildQualifiedLeadConfirmation,
} from "../lib/slackBlockKit";
import schema from "../schema";
import { convexTestModules } from "../test.setup";

async function fixture(options: { leadGenChannelId?: string } = {}) {
  const t = convexTest(schema, convexTestModules);
  const ids = await t.run(async (ctx) => {
    const tenantId = await ctx.db.insert("tenants", {
      companyName: "Slack test", contactEmail: "test@example.test", workosOrgId: "org_slack",
      status: "active", inviteExpiresAt: 0, createdBy: "test",
    });
    await ctx.db.insert("users", {
      tenantId, workosUserId: "user_slack", email: "admin@example.test", fullName: "Ana Admin",
      role: "tenant_admin", isActive: true,
    });
    const installationId = await ctx.db.insert("slackInstallations", {
      tenantId, teamId: "T1", teamName: "Team", isEnterpriseInstall: false, appId: "A1",
      botUserId: "B1", botAccessToken: "xoxb", scopes: [], notifyChannelId: "C_NOTIFY",
      notifyChannelName: "qualified", leadGenNotifyChannelId: options.leadGenChannelId,
      leadGenNotifyChannelName: options.leadGenChannelId ? "lead-gen" : undefined,
      installedByWorkosUserId: "user_slack", installedAt: 0, tokenExpiresAt: 0,
      refreshToken: "r", status: "active",
    });
    return { tenantId, installationId };
  });
  return { t, caller: t.withIdentity({ subject: "user_slack", org_id: "org_slack" }), ...ids };
}

async function scheduledFunctionNames(t: Awaited<ReturnType<typeof fixture>>["t"]) {
  return await t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").take(50)).map((job) => job.name),
  );
}

describe("qualified lead notification", () => {
  it("renders every submitted form field in the blocks and fallback text", () => {
    const message = buildQualifiedLeadConfirmation({
      leadFullName: "Jane Doe", platform: "instagram", handle: "@jane.fit", country: "Mexico",
      leadType: "pt", qualifiedBySlackUserId: "U1", submittedAt: Date.UTC(2026, 9, 9, 15),
      appUrl: "https://app.test", opportunityId: "opp",
    });
    const blocks = JSON.stringify(message.blocks);
    for (const value of ["Jane Doe", "Mexico", "PT (Personal trainer)", "Instagram", "<https://instagram.com/jane.fit|@jane.fit>", "<@U1>", "<!date^"]) {
      expect(blocks).toContain(value);
    }
    expect(message.text).toBe("Jane Doe (PT (Personal trainer), Mexico, Instagram @jane.fit) was qualified by <@U1>");
  });

  it("uses the submitted values when the lead already existed with other data", async () => {
    const { t, tenantId, installationId } = await fixture();
    const ids = await t.run(async (ctx) => {
      const leadId = await ctx.db.insert("leads", {
        tenantId, fullName: "old calendly name", country: "Spain", leadType: "content",
        status: "active", firstSeenAt: 0, updatedAt: 0,
      });
      await ctx.db.insert("leadIdentifiers", {
        tenantId, leadId, type: "instagram", value: "newer_handle", rawValue: "@newer_handle",
        source: "manual_entry", confidence: "verified", createdAt: 10,
      });
      const qualifiedBy = { slackUserId: "U1", slackTeamId: "T1", submittedAt: 5 };
      const opportunityId = await ctx.db.insert("opportunities", {
        tenantId, leadId, status: "qualified_pending", source: "slack_qualified", qualifiedBy,
        createdAt: 5, updatedAt: 5,
      });
      const qualificationEventId = await ctx.db.insert("slackQualificationEvents", {
        tenantId, installationId, leadId, opportunityId, resultKind: "created_opportunity",
        qualifiedBy, slackUserId: "U1", slackTeamId: "T1", fullNameSnapshot: "Jane Doe",
        platform: "instagram", handleSnapshot: "@jane.fit", countrySnapshot: "Mexico",
        leadTypeSnapshot: "pt", submittedAt: 5, createdAt: 5,
      });
      return { leadId, opportunityId, qualificationEventId };
    });

    const withEvent = await t.query(internal.slack.notifyData.getQualifiedLeadForNotify, { tenantId, ...ids });
    expect(withEvent).toMatchObject({
      leadFullName: "Jane Doe", handle: "@jane.fit", country: "Mexico", leadType: "pt", submittedAt: 5,
    });

    // Jobs queued before the snapshot fields fall back to the lead record.
    const legacy = await t.query(internal.slack.notifyData.getQualifiedLeadForNotify, {
      tenantId, opportunityId: ids.opportunityId, leadId: ids.leadId,
    });
    expect(legacy).toMatchObject({ leadFullName: "old calendly name", handle: "@newer_handle", country: "Spain" });
  });
});

describe("lead gen submission notification", () => {
  it("is not scheduled when the tenant has not opted in", async () => {
    const { t, caller } = await fixture();
    await caller.mutation(api.leadGen.capture.submit, {
      source: "instagram", rawHandleOrProfileUrl: "@prospect.one", originKind: "follower",
    });
    expect(await scheduledFunctionNames(t)).not.toContain("slack/notify:postLeadGenSubmission");
  });

  it("is scheduled for an opted-in tenant and reports the attempt number", async () => {
    const { t, caller, tenantId } = await fixture({ leadGenChannelId: "C_LEADGEN" });
    const first = await caller.mutation(api.leadGen.capture.submit, {
      source: "instagram", rawHandleOrProfileUrl: "https://instagram.com/prospect.one",
      originKind: "reel", originUrlOrLabel: "https://www.instagram.com/reel/abc/?igsh=1",
    });
    expect(await scheduledFunctionNames(t)).toContain("slack/notify:postLeadGenSubmission");

    const data = await t.query(internal.slack.notifyData.getLeadGenSubmissionForNotify, {
      tenantId, submissionId: first.submissionId,
    });
    expect(data).toMatchObject({
      kind: "ready", handle: "prospect.one", profileUrl: "https://instagram.com/prospect.one",
      source: "instagram", originKind: "reel", originValue: "https://www.instagram.com/reel/abc/",
      submittedByName: "Ana Admin", contactAttemptNumber: 1,
    });

    // A different worker submitting the same prospect is a repeat attempt.
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        tenantId, workosUserId: "user_second", email: "second@example.test", role: "tenant_admin", isActive: true,
      });
    });
    const second = await t.withIdentity({ subject: "user_second", org_id: "org_slack" }).mutation(
      api.leadGen.capture.submit,
      { source: "instagram", rawHandleOrProfileUrl: "@prospect.one", originKind: "story", originUrlOrLabel: "Morning story" },
    );
    const repeat = await t.query(internal.slack.notifyData.getLeadGenSubmissionForNotify, {
      tenantId, submissionId: second.submissionId as Id<"leadGenSubmissions">,
    });
    expect(repeat).toMatchObject({ contactAttemptNumber: 2, originKind: "story" });

    const message = buildLeadGenSubmissionNotification(
      repeat as Extract<typeof repeat, { kind: "ready" }>,
    );
    const blocks = JSON.stringify(message.blocks);
    for (const value of ["<https://instagram.com/prospect.one|@prospect.one>", "Story - Morning story", "Repeat - attempt #2", "second@example.test"]) {
      expect(blocks).toContain(value);
    }
  });

  it("counts attempts up to this submission only, and marks a capped count", async () => {
    const { t, caller, tenantId } = await fixture({ leadGenChannelId: "C_LEADGEN" });
    const first = await caller.mutation(api.leadGen.capture.submit, {
      source: "instagram", rawHandleOrProfileUrl: "@busy.prospect", originKind: "follower",
    });
    const [sameMsEarlier, target, sameMsLater] = await t.run(async (ctx) => {
      const base = (await ctx.db.get("leadGenSubmissions", first.submissionId))!;
      const { _id, _creationTime, ...row } = base;
      void _id;
      void _creationTime;
      const at = base.submittedAt + 1;
      const ids = [];
      for (let i = 0; i < 3; i++) {
        ids.push(await ctx.db.insert("leadGenSubmissions", { ...row, submittedAt: at, createdAt: at }));
      }
      return ids;
    });
    const attemptFor = async (submissionId: Id<"leadGenSubmissions">) =>
      await t.query(internal.slack.notifyData.getLeadGenSubmissionForNotify, { tenantId, submissionId });

    expect(await attemptFor(sameMsEarlier)).toMatchObject({ contactAttemptNumber: 2, contactAttemptCapped: false });
    expect(await attemptFor(target)).toMatchObject({ contactAttemptNumber: 3, contactAttemptCapped: false });
    expect(await attemptFor(sameMsLater)).toMatchObject({ contactAttemptNumber: 4, contactAttemptCapped: false });

    const newest = await t.run(async (ctx) => {
      const { _id, _creationTime, ...row } = (await ctx.db.get("leadGenSubmissions", first.submissionId))!;
      void _id;
      void _creationTime;
      let last = first.submissionId;
      for (let i = 0; i < 200; i++) {
        const at = row.submittedAt + 10 + i;
        last = await ctx.db.insert("leadGenSubmissions", { ...row, submittedAt: at, createdAt: at });
      }
      return last;
    });
    const capped = await attemptFor(newest);
    expect(capped).toMatchObject({ contactAttemptNumber: 200, contactAttemptCapped: true });
    const message = buildLeadGenSubmissionNotification(capped as Extract<typeof capped, { kind: "ready" }>);
    expect(JSON.stringify(message.blocks)).toContain("Repeat - attempt #200+");
    expect(message.text).toContain("attempt #200+");
  });

  it("caps eligible attempts, not rows skipped as voided or later", async () => {
    const { t, caller, tenantId } = await fixture({ leadGenChannelId: "C_LEADGEN" });
    const first = await caller.mutation(api.leadGen.capture.submit, {
      source: "instagram", rawHandleOrProfileUrl: "@boundary.prospect", originKind: "follower",
    });
    const { target, insertOlder } = await t.run(async (ctx) => {
      const { _id, _creationTime, ...row } = (await ctx.db.get("leadGenSubmissions", first.submissionId))!;
      void _id;
      void _creationTime;
      // 198 more eligible rows, with voided rows mixed in, then the 200th.
      for (let i = 1; i <= 198; i++) {
        const at = row.submittedAt + i;
        await ctx.db.insert("leadGenSubmissions", { ...row, submittedAt: at, createdAt: at });
        if (i % 40 === 0) {
          await ctx.db.insert("leadGenSubmissions", { ...row, submittedAt: at, createdAt: at, voidedAt: at });
        }
      }
      const at = row.submittedAt + 500;
      const target = await ctx.db.insert("leadGenSubmissions", { ...row, submittedAt: at, createdAt: at });
      for (let i = 0; i < 3; i++) {
        await ctx.db.insert("leadGenSubmissions", { ...row, submittedAt: at, createdAt: at });
      }
      return { target, insertOlder: { ...row, submittedAt: row.submittedAt - 1, createdAt: row.submittedAt - 1 } };
    });
    const attempt = async () =>
      await t.query(internal.slack.notifyData.getLeadGenSubmissionForNotify, { tenantId, submissionId: target });

    expect(await attempt()).toMatchObject({ contactAttemptNumber: 200, contactAttemptCapped: false });

    await t.run(async (ctx) => {
      await ctx.db.insert("leadGenSubmissions", insertOlder);
    });
    expect(await attempt()).toMatchObject({ contactAttemptNumber: 200, contactAttemptCapped: true });
  });

  it("marks the count as a minimum when voided rows exhaust the scan bound", async () => {
    const { t, caller, tenantId } = await fixture({ leadGenChannelId: "C_LEADGEN" });
    const first = await caller.mutation(api.leadGen.capture.submit, {
      source: "instagram", rawHandleOrProfileUrl: "@voided.prospect", originKind: "follower",
    });
    const target = await t.run(async (ctx) => {
      const { _id, _creationTime, ...row } = (await ctx.db.get("leadGenSubmissions", first.submissionId))!;
      void _id;
      void _creationTime;
      for (let i = 1; i <= 500; i++) {
        const at = row.submittedAt + i;
        await ctx.db.insert("leadGenSubmissions", { ...row, submittedAt: at, createdAt: at, voidedAt: at });
      }
      const at = row.submittedAt + 1000;
      return await ctx.db.insert("leadGenSubmissions", { ...row, submittedAt: at, createdAt: at });
    });
    expect(
      await t.query(internal.slack.notifyData.getLeadGenSubmissionForNotify, { tenantId, submissionId: target }),
    ).toMatchObject({ contactAttemptNumber: 1, contactAttemptCapped: true });
  });

  it("encodes pipes so a link URL can't split into a Slack label", () => {
    const message = buildLeadGenSubmissionNotification({
      handle: "prospect", profileUrl: "https://instagram.com/prospect", source: "instagram",
      originKind: "post", originValue: "https://instagram.com/p/a|b/", submittedByName: "Ana",
      contactAttemptNumber: 1, submittedAt: 0,
    });
    expect(JSON.stringify(message.blocks)).toContain("<https://instagram.com/p/a%7Cb/|Post>");
  });

  it("saves, keeps, and clears the opt-in channel", async () => {
    const { t, caller, installationId } = await fixture();
    const channels = {
      notifyChannelId: "C_NOTIFY", notifyChannelName: "qualified",
      staleReminderChannelId: "C_STALE", staleReminderChannelName: "stale",
    };
    const leadGenChannel = async () =>
      await t.run(async (ctx) => (await ctx.db.get("slackInstallations", installationId))?.leadGenNotifyChannelId ?? null);

    await caller.mutation(api.slack.channels.setSlackNotifyChannels, {
      ...channels, leadGenNotifyChannel: { channelId: "C_LEADGEN", channelName: "lead-gen" },
    });
    expect(await leadGenChannel()).toBe("C_LEADGEN");

    await caller.mutation(api.slack.channels.setSlackNotifyChannels, channels);
    expect(await leadGenChannel()).toBe("C_LEADGEN");

    await caller.mutation(api.slack.channels.setSlackNotifyChannels, { ...channels, leadGenNotifyChannel: null });
    expect(await leadGenChannel()).toBeNull();
  });
});
