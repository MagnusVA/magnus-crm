import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";
import { convexTestModules } from "../test.setup";
import { getErrorCode, getErrorMessage } from "../../lib/errors";

const ORG = "org_member_profile";
const admin = { subject: "member_admin", org_id: ORG };
const closer = { subject: "member_closer", org_id: ORG };
const loner = { subject: "member_loner", org_id: ORG };

async function fixture() {
  const t = convexTest({ schema, modules: convexTestModules });
  const ids = await t.run(async (ctx) => {
    const tenantId = await ctx.db.insert("tenants", {
      businessDayAppliedVersion: 0,
      companyName: "Members",
      contactEmail: "members@example.invalid",
      workosOrgId: ORG,
      status: "active",
      inviteExpiresAt: Date.UTC(2027, 0, 1),
      createdBy: "test",
    });
    const member = (displayName: string) =>
      ctx.db.insert("teamMembers", { tenantId, displayName, createdAt: 0, updatedAt: 0 });
    const adminMember = await member("Admin Person");
    const ana = await member("Ana Closer");
    const sofia = await member("Sofía Setter");
    const nobody = await member("No Records");
    const user = (workosUserId: string, role: "tenant_admin" | "closer", teamMemberId?: typeof ana) =>
      ctx.db.insert("users", {
        tenantId,
        workosUserId,
        role,
        fullName: workosUserId,
        teamMemberId,
        isActive: true,
        email: `${workosUserId}@example.invalid`,
      });
    await user(admin.subject, "tenant_admin", adminMember);
    const anaUser = await user(closer.subject, "closer", ana);
    // A closer whose login isn't linked to a team member yet.
    await user(loner.subject, "closer");
    const installationId = await ctx.db.insert("slackInstallations", {
      tenantId,
      teamId: "T1",
      teamName: "Team",
      isEnterpriseInstall: false,
      appId: "A1",
      botUserId: "B1",
      botAccessToken: "xoxb",
      scopes: [],
      installedByWorkosUserId: "user_slack",
      installedAt: 0,
      tokenExpiresAt: 0,
      refreshToken: "r",
      status: "active",
    });
    await ctx.db.insert("slackUsers", {
      tenantId,
      installationId,
      slackUserId: "U1",
      slackTeamId: "T1",
      realName: "Sofía",
      isBot: false,
      isDeleted: true,
      firstSeenAt: 0,
      lastSeenAt: 0,
      lastSyncedAt: 0,
      teamMemberId: sofia,
    });
    const teamId = await ctx.db.insert("attributionTeams", {
      tenantId,
      slug: "north",
      displayName: "North",
      utmSource: "north",
      normalizedUtmSource: "north",
      isActive: true,
      createdAt: 0,
      updatedAt: 0,
    });
    await ctx.db.insert("dmClosers", {
      tenantId,
      teamId,
      slug: "sofia",
      displayName: "Sofía",
      utmMedium: "sofia",
      normalizedUtmMedium: "sofia",
      isActive: false,
      createdAt: 0,
      updatedAt: 0,
      teamMemberId: sofia,
    });
    return { ana, anaUser, sofia, nobody, adminMember };
  });
  return { t, ...ids };
}

describe("getMemberProfile", () => {
  it("lets an admin open any member, with the roles their records hold", async () => {
    const f = await fixture();
    const asAdmin = f.t.withIdentity(admin);
    expect(await asAdmin.query(api.reports.member.getMemberProfile, { memberId: f.ana })).toEqual({
      teamMemberId: f.ana,
      name: "Ana Closer",
      roles: ["closer"],
      userId: f.anaUser,
      isActive: true,
    });
    // Inactive records still give the roles; the member reads as inactive.
    expect(await asAdmin.query(api.reports.member.getMemberProfile, { memberId: f.sofia })).toEqual({
      teamMemberId: f.sofia,
      name: "Sofía Setter",
      roles: ["setter", "dm_closer"],
      userId: null,
      isActive: false,
    });
    expect(await asAdmin.query(api.reports.member.getMemberProfile, { memberId: f.nobody })).toMatchObject({
      roles: [],
      isActive: false,
    });
    // With no member, an admin gets their own.
    expect(await asAdmin.query(api.reports.member.getMemberProfile, {})).toMatchObject({
      teamMemberId: f.adminMember,
    });
  });

  it("gives a closer their own profile and refuses anyone else's", async () => {
    const f = await fixture();
    const asCloser = f.t.withIdentity(closer);
    expect(await asCloser.query(api.reports.member.getMemberProfile, {})).toMatchObject({
      teamMemberId: f.ana,
      roles: ["closer"],
    });
    expect(await asCloser.query(api.reports.member.getMemberProfile, { memberId: f.ana })).toMatchObject({
      teamMemberId: f.ana,
    });
    await expect(asCloser.query(api.reports.member.getMemberProfile, { memberId: f.sofia })).rejects.toThrow(
      "You can only open your own report.",
    );
    await expect(f.t.withIdentity(loner).query(api.reports.member.getMemberProfile, {})).rejects.toThrow(
      "isn't linked to a team member",
    );
  });
});

describe("getMemberProfile refusals", () => {
  // Production replaces a plain Error's message with "Server Error", so the
  // member page branches on these codes and shows these messages.
  async function refusal(promise: Promise<unknown>) {
    const error = await promise.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    return { code: getErrorCode(error), message: getErrorMessage(error, "Server Error") };
  }

  it("refuses an unlinked closer and someone else's report with expected errors", async () => {
    const f = await fixture();
    expect(await refusal(f.t.withIdentity(loner).query(api.reports.member.getMemberProfile, {}))).toEqual({
      code: "reports.member_not_linked",
      message: "Your account isn't linked to a team member yet.",
    });
    expect(
      await refusal(f.t.withIdentity(closer).query(api.reports.member.getMemberProfile, { memberId: f.sofia })),
    ).toEqual({ code: "reports.not_own_report", message: "You can only open your own report." });
  });

  it("refuses an admin's link to a member that no longer exists with an expected error", async () => {
    const f = await fixture();
    // A merge or delete leaves old links pointing at a member that's gone.
    await f.t.run(async (ctx) => ctx.db.delete("teamMembers", f.nobody));
    expect(
      await refusal(f.t.withIdentity(admin).query(api.reports.member.getMemberProfile, { memberId: f.nobody })),
    ).toEqual({ code: "reports.invalid_member", message: "Invalid filter." });
  });
});

describe("listReportMembers", () => {
  it("lists every member for admins and refuses closers", async () => {
    const f = await fixture();
    const answer = await f.t.withIdentity(admin).query(api.reports.member.listReportMembers, {});
    expect(answer.capped).toBe(false);
    expect(answer.members.map((m) => [m.name, m.roles, m.isActive])).toEqual([
      ["Admin Person", [], true],
      ["Ana Closer", ["closer"], true],
      ["No Records", [], false],
      ["Sofía Setter", ["setter", "dm_closer"], false],
    ]);
    await expect(f.t.withIdentity(closer).query(api.reports.member.listReportMembers, {})).rejects.toThrow();
  });
});
