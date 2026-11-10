import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { rebuildQualificationRow } from "../operations/projections";
import { bookingHarness, qualifiedLifecycle } from "../../tests/bookingHarness";

const SCRIPT_TEXT = "I wasn't born on camera either fam, but once you have the right tools";

async function insertPerson(ctx: MutationCtx, tenantId: Id<"tenants">, handle: string) {
  return await ctx.db.insert("leads", {
    ...qualifiedLifecycle(0),
    tenantId,
    status: "active",
    resparkGroup: "out",
    firstSeenAt: 0,
    updatedAt: 0,
    socialHandles: [{ type: "instagram", handle }],
    searchText: handle,
  });
}

async function insertSubmission(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  installationId: Id<"slackInstallations">,
  leadId: Id<"leads">,
  fullName: string,
  submittedAt: number,
) {
  const eventId = await ctx.db.insert("slackQualificationEvents", {
    tenantId,
    installationId,
    leadId,
    resultKind: "unlinked",
    qualifiedBy: { slackUserId: "U1", slackTeamId: "T1", submittedAt },
    slackUserId: "U1",
    slackTeamId: "T1",
    fullNameSnapshot: fullName,
    platform: "instagram",
    handleSnapshot: "@dishapatelre",
    submittedAt,
    createdAt: submittedAt,
  });
  await rebuildQualificationRow(ctx, eventId);
  return eventId;
}

async function setup() {
  const harness = await bookingHarness();
  const ids = await harness.t.run(async (ctx) => {
    const installationId = await ctx.db.insert("slackInstallations", {
      tenantId: harness.tenantId, teamId: "T1", teamName: "Team", isEnterpriseInstall: false, appId: "A1",
      botUserId: "B1", botAccessToken: "xoxb", scopes: [], notifyChannelId: "C1",
      notifyChannelName: "qualified", installedByWorkosUserId: "user_slack",
      installedAt: 0, tokenExpiresAt: 0, refreshToken: "r", status: "active",
    });
    const leadId = await insertPerson(ctx, harness.tenantId, "dishapatelre");
    const otherLeadId = await insertPerson(ctx, harness.tenantId, "someoneelse");
    return {
      leadId,
      wrong: await insertSubmission(ctx, harness.tenantId, installationId, leadId, SCRIPT_TEXT, 2),
      right: await insertSubmission(ctx, harness.tenantId, installationId, leadId, "Disha P", 1),
      otherPersons: await insertSubmission(ctx, harness.tenantId, installationId, otherLeadId, "Other", 3),
    };
  });
  return { harness, ...ids };
}

describe("renamePerson", () => {
  it("renames the person and only the submissions the admin picked, with every copy of the name", async () => {
    const { harness, leadId, wrong, right } = await setup();

    const listed = await harness.admin.query(api.leads.nameAdmin.listQualificationNames, { leadId });
    expect(listed.map((row) => row.fullNameSnapshot)).toEqual([SCRIPT_TEXT, "Disha P"]);

    await harness.admin.mutation(api.leads.nameAdmin.renamePerson, {
      leadId,
      fullName: "  Disha Patel ",
      qualificationEventIds: [wrong],
    });

    const state = await harness.t.run(async (ctx) => ({
      lead: (await ctx.db.get("leads", leadId))!,
      wrong: (await ctx.db.get("slackQualificationEvents", wrong))!,
      right: (await ctx.db.get("slackQualificationEvents", right))!,
      row: await ctx.db
        .query("operationsQualificationRows")
        .withIndex("by_qualificationEventId", (q) => q.eq("qualificationEventId", wrong))
        .unique(),
      searchRow: await ctx.db
        .query("leadCustomerSearchRows")
        .withIndex("by_tenantId_and_leadId", (q) => q.eq("tenantId", harness.tenantId).eq("leadId", leadId))
        .unique(),
    }));
    expect(state.lead.fullName).toBe("Disha Patel");
    expect(state.lead.searchText).toContain("Disha Patel");
    expect(state.wrong.fullNameSnapshot).toBe("Disha Patel");
    expect(state.right.fullNameSnapshot).toBe("Disha P");
    expect(state.row?.searchText).toContain("disha patel");
    expect(state.row?.searchText).not.toContain("born on camera");
    expect(state.searchRow?.displayName).toBe("Disha Patel");
  });

  it("rejects a submission that belongs to another person, and changes nothing", async () => {
    const { harness, leadId, wrong, otherPersons } = await setup();
    await expect(
      harness.admin.mutation(api.leads.nameAdmin.renamePerson, {
        leadId,
        fullName: "Disha Patel",
        qualificationEventIds: [wrong, otherPersons],
      }),
    ).rejects.toThrow(/doesn't belong to this person/);
    const state = await harness.t.run(async (ctx) => ({
      lead: (await ctx.db.get("leads", leadId))!,
      wrong: (await ctx.db.get("slackQualificationEvents", wrong))!,
    }));
    expect(state.lead.fullName).toBeUndefined();
    expect(state.wrong.fullNameSnapshot).toBe(SCRIPT_TEXT);
  });

  it("rejects an empty name and a closer", async () => {
    const { harness, leadId } = await setup();
    await expect(
      harness.admin.mutation(api.leads.nameAdmin.renamePerson, { leadId, fullName: "  ", qualificationEventIds: [] }),
    ).rejects.toThrow(/Give a name/);
    await expect(
      harness.closer.mutation(api.leads.nameAdmin.renamePerson, {
        leadId,
        fullName: "Disha Patel",
        qualificationEventIds: [],
      }),
    ).rejects.toThrow();
  });
});
