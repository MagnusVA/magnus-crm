import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { bookingHarness, qualifiedLifecycle } from "../../tests/bookingHarness";
import { insertTeamMember, refreshSlackUserTeamMemberName } from "../lib/teamMembers";
import { teamMemberIdentity } from "../lib/memberIdentity";

const NOW = Date.parse("2026-11-03T12:00:00Z");
type Harness = Awaited<ReturnType<typeof bookingHarness>>;
afterEach(() => vi.useRealTimers());
async function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const h = await bookingHarness({ transactionLimits: true });
  const ids = await h.t.run(async ctx => {
    const admin = (await ctx.db.query("users").withIndex("by_workosUserId", q => q.eq("workosUserId", "user_admin")).unique())!;
    const closer = (await ctx.db.query("users").withIndex("by_workosUserId", q => q.eq("workosUserId", "user_closer")).unique())!;
    const member = await insertTeamMember(ctx, h.tenantId, "Yarissa Saenz");
    const closerMember = await insertTeamMember(ctx, h.tenantId, "Closer");
    await ctx.db.patch("users", admin._id, { teamMemberId: member, fullName: "Yarissa Saenz", profilePictureUrl: "https://example.com/avatar.png" });
    await ctx.db.patch("users", closer._id, { teamMemberId: closerMember });
    const teamA = await ctx.db.insert("attributionTeams", { tenantId: h.tenantId, displayName: "A", slug: "a", utmSource: "a", normalizedUtmSource: "a", isActive: true, bookingDailyQuota: 5, createdAt: NOW, updatedAt: NOW });
    const teamB = await ctx.db.insert("attributionTeams", { tenantId: h.tenantId, displayName: "B", slug: "b", utmSource: "b", normalizedUtmSource: "b", isActive: true, createdAt: NOW, updatedAt: NOW });
    const worker = await ctx.db.insert("leadGenWorkers", { tenantId: h.tenantId, userId: admin._id, workosUserId: admin.workosUserId, email: admin.email, displayName: "Yarissa Saenz", teamMemberId: member, teamId: teamA, isActive: true, createdAt: NOW, updatedAt: NOW });
    const dm = await ctx.db.insert("dmClosers", { tenantId: h.tenantId, teamMemberId: member, userId: admin._id, displayName: "Yarissa Saenz", teamId: teamB, slug: "yarissa", utmMedium: "yarissa", normalizedUtmMedium: "yarissa", isActive: true, createdAt: NOW, updatedAt: NOW });
    const installation = await ctx.db.insert("slackInstallations", { tenantId: h.tenantId, teamId: "T1", teamName: "Team", isEnterpriseInstall: false, appId: "A1", botUserId: "B1", botAccessToken: "test", scopes: [], installedByWorkosUserId: "user_admin", installedAt: NOW, tokenExpiresAt: NOW, refreshToken: "r", status: "active" });
    const slack = await ctx.db.insert("slackUsers", { tenantId: h.tenantId, installationId: installation, slackUserId: "U1", slackTeamId: "T1", realName: "Yarissa Saenz", username: "yarissa", isBot: false, isDeleted: false, teamMemberId: member, crmUserId: admin._id, firstSeenAt: NOW, lastSeenAt: NOW, lastSyncedAt: NOW });
    return { admin: admin._id, closer: closer._id, member, closerMember, teamA, teamB, worker, dm, installation, slack };
  });
  return { ...h, ids };
}
async function slackOnly(h: Awaited<ReturnType<typeof setup>>, slackUserId = "U2", name = "Someone") {
  return await h.t.run(async ctx => {
    const member = await insertTeamMember(ctx, h.tenantId, name);
    const slack = await ctx.db.insert("slackUsers", { tenantId: h.tenantId, installationId: h.ids.installation, slackUserId, slackTeamId: "T1", realName: name, isBot: false, isDeleted: false, teamMemberId: member, firstSeenAt: NOW, lastSeenAt: NOW, lastSyncedAt: NOW });
    return { member, slack };
  });
}
async function teamState(h: Awaited<ReturnType<typeof setup>>) {
  return await h.t.run(async ctx => ({ worker: await ctx.db.get("leadGenWorkers", h.ids.worker), dm: await ctx.db.get("dmClosers", h.ids.dm) }));
}

describe("team directory", () => {
  it("returns one human with each role and the dated week in force today", async () => {
    const h = await setup();
    await h.t.run(async ctx => {
      const base = { tenantId: h.tenantId, weekday: "monday" as const, updatedByUserId: h.ids.admin, updatedAt: NOW };
      await ctx.db.insert("leadGenWorkerSchedules", { ...base, workerId: h.ids.worker, userId: h.ids.admin, scheduledHours: 2 });
      await ctx.db.insert("leadGenWorkerSchedules", { ...base, workerId: h.ids.worker, userId: h.ids.admin, scheduledHours: 6, effectiveFrom: "2026-11-02" });
      await ctx.db.insert("leadGenWorkerSchedules", { ...base, workerId: h.ids.worker, userId: h.ids.admin, scheduledHours: 9, effectiveFrom: "2026-11-04" });
      await ctx.db.insert("slackQualifierSchedules", { ...base, slackUserId: "U1", scheduledHours: 3 });
      await ctx.db.insert("dmCloserSchedules", { ...base, dmCloserId: h.ids.dm, scheduledHours: 4, effectiveFrom: "2026-11-03" });
    });
    const directory = await h.admin.query(api.team.directory.getDirectory, {});
    expect(directory.today).toBe("2026-11-03");
    expect(directory.capped).toBe(false);
    const member = directory.members.find(row => row.teamMemberId === h.ids.member)!;
    expect(member).toMatchObject({ key: h.ids.member, name: "Yarissa Saenz", login: { userId: h.ids.admin, email: "admin@example.com", role: "tenant_admin", removed: false, calendlyLinked: false, invitationPending: false, profilePictureUrl: "https://example.com/avatar.png" } });
    expect(member.leadGen[0]).toMatchObject({ workerId: h.ids.worker, teamId: h.ids.teamA, week: { monday: 6, tuesday: 0 }, weekChangedOn: "2026-11-02" });
    expect(member.slack[0]).toMatchObject({ slackUserId: "U1", handle: "yarissa", week: { monday: 3 }, weekChangedOn: null });
    expect(member.dmClosers[0]).toMatchObject({ dmCloserId: h.ids.dm, teamId: h.ids.teamB, week: { monday: 4 }, weekChangedOn: "2026-11-03" });
    expect(directory.teams.find(row => row.teamId === h.ids.teamA)?.bookingDailyQuota).toBe(5);
  });
  it("uses a tenant's business date and includes legacy records with fallback keys", async () => {
    const h = await setup();
    vi.setSystemTime(Date.parse("2026-11-03T06:30:00Z"));
    await h.t.run(ctx => ctx.db.patch("users", h.ids.closer, { teamMemberId: undefined }));
    const result = await h.admin.query(api.team.directory.getDirectory, {});
    expect(result.today).toBe("2026-11-02");
    expect(result.members.find(row => row.key === `users:${h.ids.closer}`)?.teamMemberId).toBeNull();
  });
  it("flags capped reads and skips bots", async () => {
    const h = await setup();
    await h.t.run(async ctx => {
      await ctx.db.patch("slackUsers", h.ids.slack, { isBot: true });
      for (let i = 0; i < 501; i++) await insertTeamMember(ctx, h.tenantId, `Empty ${i}`);
    });
    const result = await h.admin.query(api.team.directory.getDirectory, {});
    expect(result.capped).toBe(true);
    expect(result.members.flatMap(row => row.slack)).toEqual([]);
  });
});

describe("review and decisions", () => {
  it("each kind disappears after decide and returns after reopen", async () => {
    const h = await setup();
    const duplicate = await slackOnly(h, "U2", "Yaríssa   Saenz");
    const review = await h.admin.query(api.team.review.listReviewItems, {});
    expect(new Set(review.items.map(item => item.kind))).toEqual(new Set(["same_human", "slack_unlinked", "teams_disagree"]));
    const same = review.items.find(item => item.kind === "same_human");
    expect(same).toMatchObject({ into: h.ids.member, canJoin: true, reasons: ["same_name"], members: expect.arrayContaining([duplicate.member, h.ids.member]) });
    for (const item of review.items) {
      await h.admin.mutation(api.team.review.decide, { key: item.key });
      await h.admin.mutation(api.team.review.decide, { key: item.key });
      expect((await h.admin.query(api.team.review.listReviewItems, {})).items.some(row => row.key === item.key)).toBe(false);
      await h.admin.mutation(api.team.review.reopen, { key: item.key });
      expect((await h.admin.query(api.team.review.listReviewItems, {})).items.some(row => row.key === item.key)).toBe(true);
    }
  });
  it("matches worker and login emails first without joining automatically", async () => {
    const h = await setup();
    const other = await h.t.run(async ctx => {
      const member = await insertTeamMember(ctx, h.tenantId, "Different name");
      await ctx.db.insert("leadGenWorkers", { tenantId: h.tenantId, userId: h.ids.admin, workosUserId: "old", email: " ADMIN@example.com ", teamId: h.ids.teamA, teamMemberId: member, isActive: false, createdAt: NOW, updatedAt: NOW });
      return member;
    });
    const review = await h.admin.query(api.team.review.listReviewItems, {});
    expect(review.items.find(item => item.kind === "same_human" && item.members.includes(other))).toMatchObject({ reasons: ["same_email", "same_team"], into: h.ids.member });
    expect(await h.t.run(ctx => ctx.db.get("teamMembers", other))).not.toBeNull();
  });
});

describe("joining members", () => {
  it("blocks two active logins, including the review suggestion", async () => {
    const h = await setup();
    await h.t.run(ctx => ctx.db.patch("teamMembers", h.ids.closerMember, { displayName: "Yarissa Saenz" }));
    expect((await h.admin.query(api.team.review.listReviewItems, {})).items.find(item => item.kind === "same_human")).toMatchObject({ canJoin: false, blockedReason: expect.stringContaining("active login") });
    await expect(h.admin.mutation(api.team.review.joinTeamMembers, { fromTeamMemberId: h.ids.closerMember, intoTeamMemberId: h.ids.member })).rejects.toThrow("active login");
  });
  it.each(["deleted", "inactive"])("allows a %s login and prefers the active login for identity and directory", async kind => {
    const h = await setup();
    await h.t.run(ctx => ctx.db.patch("users", h.ids.admin, kind === "deleted" ? { deletedAt: NOW } : { isActive: false }));
    // The caller uses the closer login, temporarily promoted to admin.
    await h.t.run(ctx => ctx.db.patch("users", h.ids.closer, { role: "tenant_admin", fullName: "Active login" }));
    expect(await h.closer.mutation(api.team.review.joinTeamMembers, { fromTeamMemberId: h.ids.member, intoTeamMemberId: h.ids.closerMember })).toEqual({ done: true });
    expect((await h.closer.query(api.team.directory.getDirectory, {})).members.find(row => row.teamMemberId === h.ids.closerMember)?.login?.userId).toBe(h.ids.closer);
    expect((await h.t.run(ctx => teamMemberIdentity(ctx, h.tenantId, h.ids.closerMember)))?.identity.id).toBe(h.ids.closer);
  });
  it("resumes automatically beyond pages of role records, events and attribution", async () => {
    const h = await setup();
    const source = await slackOnly(h);
    const credit = await seedCredit(h, source.member);
    await h.t.run(async ctx => {
      const row = (await ctx.db.get("dealAttributions", credit.row))!;
      const { _id, _creationTime, ...attribution } = row;
      void _id; void _creationTime;
      for (let i = 0; i < 205; i++) await ctx.db.insert("dealAttributions", attribution);
      for (let i = 0; i < 55; i++) await ctx.db.insert("slackUsers", { tenantId: h.tenantId, installationId: h.ids.installation, slackUserId: `many-${i}`, slackTeamId: "T1", isBot: false, isDeleted: false, teamMemberId: source.member, firstSeenAt: NOW, lastSeenAt: NOW, lastSyncedAt: NOW });
      for (let i = 0; i < 205; i++) await ctx.db.insert("domainEvents", { tenantId: h.tenantId, entityType: "user", entityId: h.ids.admin, eventType: "test", occurredAt: NOW + i, source: "admin", teamMemberId: source.member });
    });
    expect(await h.admin.mutation(api.team.review.joinTeamMembers, { fromTeamMemberId: source.member, intoTeamMemberId: h.ids.member })).toEqual({ done: false });
    await h.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await h.t.run(ctx => ctx.db.get("teamMembers", source.member))).toBeNull();
    const events = await h.t.run(ctx => ctx.db.query("domainEvents").take(300));
    expect(events).toHaveLength(207);
    expect(events.every(row => row.teamMemberId === h.ids.member)).toBe(true);
    const slack = await h.t.run(ctx => ctx.db.query("slackUsers").take(100));
    expect(slack.every(row => row.teamMemberId === h.ids.member)).toBe(true);
    const attribution = await h.t.run(ctx => ctx.db.query("dealAttributions").take(300));
    expect(attribution).toHaveLength(206);
    expect(attribution.every(row => row.teamMemberId === h.ids.member)).toBe(true);
  });
});

describe("team edits", () => {
  it("sets every role, restores the snapshot, and keeps DM teams on null", async () => {
    const h = await setup();
    const result = await h.admin.mutation(api.team.review.setTeamEverywhere, { teamMemberId: h.ids.member, teamId: h.ids.teamA });
    expect(result.previous).toEqual({ leadGen: [{ workerId: h.ids.worker, teamId: h.ids.teamA }], dmClosers: [{ dmCloserId: h.ids.dm, teamId: h.ids.teamB }] });
    expect((await teamState(h)).dm?.teamId).toBe(h.ids.teamA);
    await h.admin.mutation(api.team.review.restoreTeams, { previous: result.previous });
    expect((await teamState(h)).dm?.teamId).toBe(h.ids.teamB);
    const cleared = await h.admin.mutation(api.team.review.setTeamEverywhere, { teamMemberId: h.ids.member, teamId: null });
    expect(cleared.dmClosersKeptTeam).toBe(true);
    expect((await teamState(h)).worker?.teamId).toBeUndefined();
    expect((await teamState(h)).dm?.teamId).toBe(h.ids.teamB);
    await h.admin.mutation(api.team.review.restoreTeams, { previous: cleared.previous });
    expect((await teamState(h)).worker?.teamId).toBe(h.ids.teamA);
  });
  it("rejects archived lead gen teams and duplicate active UTM media atomically", async () => {
    const h = await setup();
    await h.t.run(ctx => ctx.db.patch("attributionTeams", h.ids.teamA, { isActive: false }));
    await expect(h.admin.mutation(api.team.review.setTeamEverywhere, { teamMemberId: h.ids.member, teamId: h.ids.teamA })).rejects.toThrow("active DM team");
    await h.t.run(async ctx => {
      await ctx.db.patch("attributionTeams", h.ids.teamA, { isActive: true });
      const dm = (await ctx.db.get("dmClosers", h.ids.dm))!;
      const { _id, _creationTime, ...copy } = dm;
      void _id; void _creationTime;
      await ctx.db.insert("dmClosers", copy);
    });
    await expect(h.admin.mutation(api.team.review.setTeamEverywhere, { teamMemberId: h.ids.member, teamId: h.ids.teamA })).rejects.toThrow("UTM medium");
    expect((await teamState(h)).dm?.teamId).toBe(h.ids.teamB);
  });
});

async function seedCredit(h: Awaited<ReturnType<typeof setup>>, member: Id<"teamMembers">) {
  return await h.t.run(async ctx => {
    const lead = await ctx.db.insert("leads", { tenantId: h.tenantId, fullName: "Lead", status: "active", firstSeenAt: NOW, updatedAt: NOW, ...qualifiedLifecycle(NOW) });
    const opportunity = await ctx.db.insert("opportunities", { tenantId: h.tenantId, leadId: lead, stage: "qualified", outcome: "open", source: "slack_qualified", qualifiedBy: { slackUserId: "U2", slackTeamId: "T1", submittedAt: NOW }, createdAt: NOW, updatedAt: NOW });
    const qualification = await ctx.db.insert("slackQualificationEvents", { tenantId: h.tenantId, installationId: h.ids.installation, leadId: lead, opportunityId: opportunity, resultKind: "created_opportunity", qualifiedBy: { slackUserId: "U2", slackTeamId: "T1", submittedAt: NOW }, slackUserId: "U2", slackTeamId: "T1", fullNameSnapshot: "Lead", platform: "instagram", handleSnapshot: "lead", submittedAt: NOW, createdAt: NOW });
    const row = await ctx.db.insert("dealAttributions", { tenantId: h.tenantId, opportunityId: opportunity, role: "setter", teamMemberId: member, source: { kind: "slack_qualification", slackUserId: "U2", qualificationEventId: qualification }, attributedAt: NOW, createdAt: NOW });
    const event = await ctx.db.insert("domainEvents", { tenantId: h.tenantId, entityType: "opportunity", entityId: opportunity, eventType: "opportunity.created", source: "pipeline", teamMemberId: member, occurredAt: NOW });
    const touch = await ctx.db.insert("domainEvents", { tenantId: h.tenantId, entityType: "lead", entityId: lead, eventType: "lead.slack_qualified", source: "pipeline", teamMemberId: member, metadata: JSON.stringify({ qualificationEventId: qualification }), occurredAt: NOW });
    return { row, event, touch };
  });
}
async function creditOwners(h: Harness, ids: Awaited<ReturnType<typeof seedCredit>>) {
  return await h.t.run(async ctx => [(await ctx.db.get("dealAttributions", ids.row))?.teamMemberId, (await ctx.db.get("domainEvents", ids.event))?.teamMemberId, (await ctx.db.get("domainEvents", ids.touch))?.teamMemberId]);
}
describe("Slack links and credit", () => {
  it("moves the attribution and domain events on link and unlink, and restores Undo", async () => {
    const h = await setup();
    const source = await slackOnly(h);
    const credit = await seedCredit(h, source.member);
    const linked = await h.admin.mutation(api.team.members.linkSlackUser, { slackUserId: "U2", teamMemberId: h.ids.member });
    await h.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await creditOwners(h, credit)).toEqual([h.ids.member, h.ids.member, h.ids.member]);
    expect((await h.t.run(ctx => ctx.db.get("slackUsers", source.slack)))?.crmUserId).toBe(h.ids.admin);
    const unlinked = await h.admin.mutation(api.team.members.unlinkSlackUser, { slackUserId: "U2" });
    await h.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await creditOwners(h, credit)).toEqual([unlinked.teamMemberId, unlinked.teamMemberId, unlinked.teamMemberId]);
    await h.admin.mutation(api.team.members.restoreSlackUserLink, { previous: unlinked.previous });
    await h.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await creditOwners(h, credit)).toEqual([h.ids.member, h.ids.member, h.ids.member]);
    await h.admin.mutation(api.team.members.restoreSlackUserLink, { previous: linked.previous });
    await h.t.finishAllScheduledFunctions(vi.runAllTimers);
    // The Slack-only member emptied by the link is gone; Undo gives the Slack
    // user a member of its own again, with its credit.
    expect(await h.t.run(ctx => ctx.db.get("teamMembers", source.member))).toBeNull();
    const restored = (await h.t.run(ctx => ctx.db.get("slackUsers", source.slack)))!.teamMemberId!;
    expect(restored).not.toBe(h.ids.member);
    expect(await creditOwners(h, credit)).toEqual([restored, restored, restored]);
  });
  it("joins a Slack-only member into a member without a login, then recreates it for Undo", async () => {
    const h = await setup();
    const source = await slackOnly(h);
    const target = await h.t.run(ctx => insertTeamMember(ctx, h.tenantId, "No login"));
    const credit = await seedCredit(h, source.member);
    const result = await h.admin.mutation(api.team.members.linkSlackUser, { slackUserId: "U2", teamMemberId: target });
    await h.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await creditOwners(h, credit)).toEqual([target, target, target]);
    expect(await h.t.run(ctx => ctx.db.get("teamMembers", source.member))).toBeNull();
    await h.admin.mutation(api.team.members.restoreSlackUserLink, { previous: result.previous });
    await h.t.finishAllScheduledFunctions(vi.runAllTimers);
    const restored = (await h.t.run(ctx => ctx.db.get("slackUsers", source.slack)))!.teamMemberId;
    expect(restored).not.toBe(target);
    expect(await creditOwners(h, credit)).toEqual([restored, restored, restored]);
  });
  it("a Slack profile refresh cannot rename a member shared with another role", async () => {
    const h = await setup();
    await h.t.run(async ctx => {
      await ctx.db.patch("users", h.ids.admin, { teamMemberId: h.ids.closerMember });
      await ctx.db.patch("slackUsers", h.ids.slack, { crmUserId: undefined, realName: "New Slack name" });
      await refreshSlackUserTeamMemberName(ctx, h.ids.slack);
    });
    expect((await h.t.run(ctx => ctx.db.get("teamMembers", h.ids.member)))?.displayName).toBe("Yarissa Saenz");
  });
  it("never moves another role's events when a Slack user leaves a shared member", async () => {
    const h = await setup();
    const source = await slackOnly(h);
    const credit = await seedCredit(h, source.member);
    await h.admin.mutation(api.team.members.linkSlackUser, { slackUserId: "U2", teamMemberId: h.ids.member });
    await h.t.finishAllScheduledFunctions(vi.runAllTimers);
    const unrelated = await h.t.run(ctx => ctx.db.insert("domainEvents", { tenantId: h.tenantId, entityType: "user", entityId: h.ids.admin, eventType: "user.updated", source: "admin", actorUserId: h.ids.admin, teamMemberId: h.ids.member, occurredAt: NOW }));
    const result = await h.admin.mutation(api.team.members.unlinkSlackUser, { slackUserId: "U2" });
    await h.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await creditOwners(h, credit)).toEqual([result.teamMemberId, result.teamMemberId, result.teamMemberId]);
    expect((await h.t.run(ctx => ctx.db.get("domainEvents", unrelated)))?.teamMemberId).toBe(h.ids.member);
  });
  it("a quick unlink before repoint finishes keeps credit on the current owner", async () => {
    const h = await setup();
    const source = await slackOnly(h);
    const credit = await seedCredit(h, source.member);
    await h.admin.mutation(api.team.members.linkSlackUser, { slackUserId: "U2", teamMemberId: h.ids.member });
    const result = await h.admin.mutation(api.team.members.unlinkSlackUser, { slackUserId: "U2" });
    await h.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await creditOwners(h, credit)).toEqual([result.teamMemberId, result.teamMemberId, result.teamMemberId]);
  });
});

it("rejects a closer on every public endpoint", async () => {
  const h = await setup();
  const calls = [
    () => h.closer.query(api.team.directory.getDirectory, {}),
    () => h.closer.query(api.team.review.listReviewItems, {}),
    () => h.closer.mutation(api.team.review.decide, { key: "slack_only:U1" }),
    () => h.closer.mutation(api.team.review.reopen, { key: "slack_only:U1" }),
    () => h.closer.mutation(api.team.review.joinTeamMembers, { fromTeamMemberId: h.ids.member, intoTeamMemberId: h.ids.closerMember }),
    () => h.closer.mutation(api.team.review.setTeamEverywhere, { teamMemberId: h.ids.member, teamId: null }),
    () => h.closer.mutation(api.team.review.restoreTeams, { previous: { leadGen: [], dmClosers: [] } }),
    () => h.closer.mutation(api.team.members.linkSlackUser, { slackUserId: "U1", teamMemberId: h.ids.member }),
    () => h.closer.mutation(api.team.members.unlinkSlackUser, { slackUserId: "U1" }),
    () => h.closer.mutation(api.team.members.restoreSlackUserLink, { previous: { links: [] } }),
  ];
  for (const call of calls) await expect(call()).rejects.toThrow("Insufficient permissions");
});

describe("no empty members left behind", () => {
  it("an unlink and its Undo leave no empty member, so Review has nothing to suggest", async () => {
    const h = await setup();
    await slackOnly(h, "U2", "Yarissa Saenz");
    await h.admin.mutation(api.team.members.linkSlackUser, { slackUserId: "U2", teamMemberId: h.ids.member });
    await h.t.finishAllScheduledFunctions(vi.runAllTimers);
    const unlinked = await h.admin.mutation(api.team.members.unlinkSlackUser, { slackUserId: "U2" });
    await h.t.finishAllScheduledFunctions(vi.runAllTimers);
    await h.admin.mutation(api.team.members.restoreSlackUserLink, { previous: unlinked.previous });
    await h.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await h.t.run(ctx => ctx.db.get("teamMembers", unlinked.teamMemberId))).toBeNull();
    const review = await h.admin.query(api.team.review.listReviewItems, {});
    expect(review.items.filter(item => item.kind === "same_human")).toEqual([]);
  });

  it("refuses to unlink a Slack user who is already on their own", async () => {
    const h = await setup();
    await slackOnly(h, "U2", "Alone");
    await expect(h.admin.mutation(api.team.members.unlinkSlackUser, { slackUserId: "U2" })).rejects.toThrow(/isn't linked to anyone/);
  });

  it("on a tie, keeps the member with more than a Slack user", async () => {
    const h = await setup();
    const dmOnly = await h.t.run(async ctx => {
      const member = await insertTeamMember(ctx, h.tenantId, "Claudio Vasquez");
      await ctx.db.insert("dmClosers", { tenantId: h.tenantId, teamMemberId: member, displayName: "Claudio Vasquez", teamId: h.ids.teamB, slug: "claudio", utmMedium: "claudio", normalizedUtmMedium: "claudio", isActive: true, createdAt: NOW, updatedAt: NOW });
      return member;
    });
    await slackOnly(h, "U3", "Claudio Vasquez");
    const review = await h.admin.query(api.team.review.listReviewItems, {});
    const pair = review.items.find(item => item.kind === "same_human" && item.members.includes(dmOnly));
    expect(pair).toMatchObject({ into: dmOnly, canJoin: true });
  });
});

describe("a join still finishing", () => {
  it("locks its members against links until it ends", async () => {
    const h = await setup();
    const source = await slackOnly(h, "U2", "Locked");
    const target = await h.t.run(ctx => insertTeamMember(ctx, h.tenantId, "Target"));
    await h.t.run(ctx => ctx.db.insert("teamReviewDecisions", { tenantId: h.tenantId, key: `joining:${source.member}:${target}`, decidedByUserId: h.ids.admin, decidedAt: NOW }));
    await expect(h.admin.mutation(api.team.members.linkSlackUser, { slackUserId: "U2", teamMemberId: h.ids.member })).rejects.toThrow(/still finishing/);
    await expect(h.admin.mutation(api.team.review.setTeamEverywhere, { teamMemberId: target, teamId: null })).rejects.toThrow(/still finishing/);
  });
});
