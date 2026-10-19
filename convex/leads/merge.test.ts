/**
 * Lead merge. After a merge, only history (leadMergeHistory, domainEvents)
 * and the merged source lead's own records may still name the source lead.
 */
import { afterEach, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc, Id, TableNames } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import schema from "../schema";
import { bookingHarness, bookingPayload, qualifiedLifecycle } from "../../tests/bookingHarness";
import { preserveQualificationAuditMatchForScheduledMeeting } from "../leadGen/auditMatching";
import { upsertOpportunitySearchProjection } from "../lib/opportunitySearch";
import { rebuildQualificationRow } from "../operations/projections";

afterEach(() => vi.useRealTimers());

type Harness = Awaited<ReturnType<typeof bookingHarness>>;
type Fields<T extends TableNames> = Omit<Partial<Doc<T>>, "_id" | "_creationTime">;

const AT = Date.parse("2026-10-01T00:00:00Z");
// Mirrors MERGE_OPPORTUNITY_LIMIT in merge.ts.
const OPPORTUNITY_LIMIT = 50;
// Pads test documents to about the size of production opportunities and
// meetings, so read limits apply as they would in production.
const PADDING = "x".repeat(1_200);

async function setup(options?: { transactionLimits?: boolean }) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-14T00:00:00Z"));
  return await bookingHarness(options);
}

async function userId(ctx: MutationCtx, workosUserId: string) {
  const user = await ctx.db
    .query("users")
    .withIndex("by_workosUserId", (q) => q.eq("workosUserId", workosUserId))
    .unique();
  if (!user) throw new Error(`Missing user ${workosUserId}`);
  return user._id;
}

async function insertLead(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  fields: Fields<"leads"> = {},
) {
  return await ctx.db.insert("leads", {
    tenantId,
    ...qualifiedLifecycle(AT),
    status: "active",
    firstSeenAt: AT,
    updatedAt: AT,
    ...fields,
  });
}

async function insertOpportunity(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  leadId: Id<"leads">,
  fields: Fields<"opportunities"> = {},
) {
  return await ctx.db.insert("opportunities", {
    tenantId,
    leadId,
    status: "scheduled",
    source: "calendly",
    createdAt: AT,
    updatedAt: AT,
    ...fields,
  });
}

async function insertSlackInstallation(ctx: MutationCtx, tenantId: Id<"tenants">) {
  return await ctx.db.insert("slackInstallations", {
    tenantId,
    teamId: "T1",
    teamName: "Team",
    isEnterpriseInstall: false,
    appId: "A1",
    botUserId: "B1",
    botAccessToken: "xoxb-test",
    scopes: [],
    installedByWorkosUserId: "user_admin",
    installedAt: AT,
    tokenExpiresAt: AT,
    refreshToken: "refresh",
    status: "active",
  });
}

function slackEvent(
  tenantId: Id<"tenants">,
  installationId: Id<"slackInstallations">,
  leadId: Id<"leads">,
  opportunityId?: Id<"opportunities">,
) {
  return {
    tenantId,
    installationId,
    leadId,
    opportunityId,
    resultKind: opportunityId ? ("already_booked" as const) : ("unlinked" as const),
    qualifiedBy: { slackUserId: "U1", slackTeamId: "T1", submittedAt: AT },
    slackUserId: "U1",
    slackTeamId: "T1",
    fullNameSnapshot: "Sam Source",
    platform: "instagram" as const,
    handleSnapshot: "samsource",
    submittedAt: AT,
    createdAt: AT,
  };
}

/**
 * An opportunity with `meetings` meetings, each with a webhook receipt and
 * `formResponses` form responses, plus a follow-up and, given an
 * installation, a Slack qualification event and its operations row.
 */
async function seedDeal(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    leadId: Id<"leads">;
    key: string;
    meetings: number;
    formResponses: number;
    installationId?: Id<"slackInstallations">;
    padded?: boolean;
    opportunity?: Fields<"opportunities">;
  },
) {
  const { tenantId, leadId, key } = args;
  const notes = args.padded ? PADDING : undefined;
  const closerId = await userId(ctx, "user_closer");
  const opportunityId = await insertOpportunity(ctx, tenantId, leadId, {
    notes,
    ...args.opportunity,
  });
  for (let m = 0; m < args.meetings; m += 1) {
    const eventUri = `https://api.calendly.com/scheduled_events/${key}-${m}`;
    const inviteeUri = `${eventUri}/invitees/person`;
    const meetingId = await ctx.db.insert("meetings", {
      tenantId,
      opportunityId,
      assignedCloserId: closerId,
      calendlyEventUri: eventUri,
      calendlyInviteeUri: inviteeUri,
      scheduledAt: AT,
      durationMinutes: 30,
      status: "scheduled",
      createdAt: AT,
      notes,
    });
    for (let r = 0; r < args.formResponses; r += 1) {
      await ctx.db.insert("meetingFormResponses", {
        tenantId,
        meetingId,
        opportunityId,
        leadId,
        fieldKey: `q_${r}`,
        questionLabelSnapshot: `Question ${r}`,
        answerText: "Answer",
        capturedAt: AT,
      });
    }
    const rawEventId = await ctx.db.insert("rawWebhookEvents", {
      tenantId,
      calendlyEventUri: inviteeUri,
      eventType: "invitee.created",
      payload: "{}",
      processed: true,
      receivedAt: AT,
    });
    await ctx.db.insert("webhookDeliveries", {
      tenantId,
      key: `${key}-${m}`,
      eventType: "invitee.created",
      inviteeUri,
      eventUri,
      rawEventId,
      occurredAt: AT,
      receivedAt: AT,
      status: "applied",
      generation: 1,
      meetingId,
      opportunityId,
      leadId,
    });
  }
  await ctx.db.insert("followUps", {
    tenantId,
    opportunityId,
    leadId,
    closerId,
    type: "manual_reminder",
    reason: "closer_initiated",
    status: "pending",
    createdAt: AT,
  });
  if (args.installationId) {
    const eventId = await ctx.db.insert(
      "slackQualificationEvents",
      slackEvent(tenantId, args.installationId, leadId, opportunityId),
    );
    await rebuildQualificationRow(ctx, eventId);
  }
  return opportunityId;
}

async function insertProspect(ctx: MutationCtx, tenantId: Id<"tenants">, handle: string) {
  const adminId = await userId(ctx, "user_admin");
  const worker = await ctx.db
    .query("leadGenWorkers")
    .withIndex("by_tenantId_and_userId", (q) => q.eq("tenantId", tenantId).eq("userId", adminId))
    .unique();
  const workerId =
    worker?._id ??
    (await ctx.db.insert("leadGenWorkers", {
      tenantId,
      userId: adminId,
      workosUserId: "user_admin",
      email: "admin@example.com",
      isActive: true,
      createdAt: AT,
      updatedAt: AT,
    }));
  return await ctx.db.insert("leadGenProspects", {
    tenantId,
    firstSource: "instagram",
    latestSource: "instagram",
    dedupeKey: `instagram:${handle}`,
    normalizedHandle: handle,
    rawHandle: `@${handle}`,
    profileUrl: `https://instagram.com/${handle}`,
    firstCapturedByWorkerId: workerId,
    firstCapturedAt: AT,
    lastSubmittedByWorkerId: workerId,
    lastSubmittedAt: AT,
    latestOriginKind: "follower",
    contactAttemptCount: 1,
    distinctWorkerCount: 1,
    createdAt: AT,
    updatedAt: AT,
  });
}

async function insertMatch(
  ctx: MutationCtx,
  prospectId: Id<"leadGenProspects">,
  leadId: Id<"leads">,
  fields: Fields<"leadGenAuditMatches"> = {},
) {
  const prospect = await ctx.db.get("leadGenProspects", prospectId);
  if (!prospect) throw new Error("Missing prospect");
  return await ctx.db.insert("leadGenAuditMatches", {
    tenantId: prospect.tenantId,
    prospectId,
    leadId,
    matchSource: "slack_qualification",
    matchStatus: "accepted",
    matchedVia: "social_handle",
    normalizedHandle: prospect.normalizedHandle,
    createdAt: AT,
    updatedAt: AT,
    ...fields,
  });
}

/** Books a Calendly meeting through the real pipeline, with form answers. */
async function bookLead({ t, tenantId }: Harness, key: string, email: string, name: string) {
  const payload = {
    ...bookingPayload(key, email),
    name,
    questions_and_answers: [
      { question: "Where are you based?", answer: "Toronto", position: 0 },
      { question: "What is your main goal?", answer: "More clients", position: 1 },
    ],
  };
  await t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
    tenantId,
    calendlyEventUri: payload.uri,
    eventType: "invitee.created",
    payload: JSON.stringify({ created_at: "2026-09-30T12:00:00Z", payload }),
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  return await t.run(async (ctx) => {
    const meeting = await ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_calendlyEventUri", (q) =>
        q.eq("tenantId", tenantId).eq("calendlyEventUri", payload.scheduled_event.uri),
      )
      .unique();
    const opportunity = meeting && (await ctx.db.get("opportunities", meeting.opportunityId));
    if (!meeting || !opportunity) throw new Error("The booking was not applied");
    return { meetingId: meeting._id, opportunityId: opportunity._id, leadId: opportunity.leadId };
  });
}

async function dumpTables(ctx: MutationCtx) {
  const dump: Partial<Record<TableNames, Array<{ _id: string }>>> = {};
  for (const table of Object.keys(schema.tables) as TableNames[]) {
    dump[table] = await ctx.db.query(table).take(10_000);
  }
  return dump;
}

// History keeps naming the merged lead, and so does its own (hidden)
// lead/customer search row.
const MAY_NAME_MERGED_LEAD = new Set(["leadMergeHistory", "domainEvents", "leadCustomerSearchRows"]);

/** `table:_id` for every row, other than the lead itself, that contains its ID. */
async function rowsNaming({ t }: Harness, leadId: Id<"leads">) {
  const dump = await t.run(dumpTables);
  return Object.entries(dump).flatMap(([table, docs]) =>
    MAY_NAME_MERGED_LEAD.has(table)
      ? []
      : (docs ?? [])
          .filter((doc) => doc._id !== leadId && JSON.stringify(doc).includes(leadId))
          .map((doc) => `${table}:${doc._id}`),
  );
}

async function countFormResponses({ t }: Harness, leadId: Id<"leads">) {
  return await t.run(async (ctx) =>
    (
      await ctx.db
        .query("meetingFormResponses")
        .withIndex("by_leadId", (q) => q.eq("leadId", leadId))
        .take(1_000)
    ).length,
  );
}

async function countFlagged({ t, tenantId }: Harness, leadId: Id<"leads">) {
  return await t.run(async (ctx) =>
    (
      await ctx.db
        .query("opportunities")
        .withIndex("by_tenantId_and_potentialDuplicateLeadId", (q) =>
          q.eq("tenantId", tenantId).eq("potentialDuplicateLeadId", leadId),
        )
        .take(1_000)
    ).length,
  );
}

it("moves every row that names the source lead onto the target", async () => {
  const h = await setup();
  const { t, tenantId, admin } = h;
  const booked = await bookLead(h, "merge-source", "source@example.com", "Sam Source");
  const sourceLeadId = booked.leadId;

  const seeded = await t.run(async (ctx) => {
    const closerId = await userId(ctx, "user_closer");
    const adminId = await userId(ctx, "user_admin");
    // Fields the target lacks, and one custom field both leads have.
    await ctx.db.patch("leads", sourceLeadId, {
      phone: "+14165550142",
      country: "Canada",
      leadType: "pt",
      customFields: { city: "Toronto", goal: "More clients" },
      customFieldLabels: { city: "City", goal: "Main goal" },
    });
    const targetLeadId = await insertLead(ctx, tenantId, {
      fullName: "Sam Target",
      email: "target@example.com",
      customFields: { city: "Vancouver" },
      customFieldLabels: { city: "Where are you based?" },
    });
    await ctx.db.patch("opportunities", booked.opportunityId, {
      potentialDuplicateLeadId: targetLeadId,
    });
    // A lead merged into the source earlier.
    const earlierLeadId = await insertLead(ctx, tenantId, {
      fullName: "Sam Earlier",
      status: "merged",
      mergedIntoLeadId: sourceLeadId,
    });
    await ctx.db.insert("leadMergeHistory", {
      tenantId,
      sourceLeadId: earlierLeadId,
      targetLeadId: sourceLeadId,
      mergedByUserId: adminId,
      mergedAt: AT,
      identifiersMoved: 0,
      opportunitiesMoved: 0,
      meetingsMoved: 0,
    });
    await ctx.db.insert("followUps", {
      tenantId,
      opportunityId: booked.opportunityId,
      leadId: sourceLeadId,
      closerId,
      type: "manual_reminder",
      reason: "closer_initiated",
      status: "pending",
      createdAt: AT,
    });

    // One Slack event on the opportunity, one on the lead alone. The
    // target has a deal and an event of its own.
    const installationId = await insertSlackInstallation(ctx, tenantId);
    for (const event of [
      slackEvent(tenantId, installationId, sourceLeadId, booked.opportunityId),
      slackEvent(tenantId, installationId, sourceLeadId),
    ]) {
      await rebuildQualificationRow(ctx, await ctx.db.insert("slackQualificationEvents", event));
    }
    const targetOpportunityId = await seedDeal(ctx, {
      tenantId,
      leadId: targetLeadId,
      key: "merge-target",
      meetings: 1,
      formResponses: 0,
    });
    await upsertOpportunitySearchProjection(ctx, targetOpportunityId);
    const targetEventId = await ctx.db.insert(
      "slackQualificationEvents",
      slackEvent(tenantId, installationId, targetLeadId),
    );
    await rebuildQualificationRow(ctx, targetEventId);

    // One prospect matched only the source; another matched both leads.
    const prospectId = await insertProspect(ctx, tenantId, "samsource");
    const sourceMatchId = await insertMatch(ctx, prospectId, sourceLeadId, {
      opportunityId: booked.opportunityId,
    });
    const sharedProspectId = await insertProspect(ctx, tenantId, "samshared");
    const duplicateMatchId = await insertMatch(ctx, sharedProspectId, sourceLeadId);
    const targetMatchId = await insertMatch(ctx, sharedProspectId, targetLeadId);
    await ctx.db.patch("leadGenProspects", sharedProspectId, {
      currentAuditMatchId: duplicateMatchId,
    });

    const teamId = await ctx.db.insert("attributionTeams", {
      tenantId,
      slug: "team",
      displayName: "Team",
      utmSource: "team",
      normalizedUtmSource: "team",
      isActive: true,
      createdAt: AT,
      updatedAt: AT,
    });
    const dmCloserId = await ctx.db.insert("dmClosers", {
      tenantId,
      teamId,
      slug: "dm",
      displayName: "DM Closer",
      utmMedium: "dm",
      normalizedUtmMedium: "dm",
      isActive: true,
      createdAt: AT,
      updatedAt: AT,
    });
    await ctx.db.insert("linkPortalLeadEdits", {
      tenantId,
      leadId: sourceLeadId,
      dmCloserId,
      sessionIdHash: "session",
      createdAt: AT,
      changedFields: ["initialSource"],
    });
    await ctx.db.insert("leadNotes", {
      tenantId,
      leadId: sourceLeadId,
      content: "Prefers mornings",
      createdAt: AT,
      authorKind: "dm_closer",
      dmCloserId,
    });
    return {
      targetLeadId,
      earlierLeadId,
      targetOpportunityId,
      targetEventId,
      sourceMatchId,
      targetMatchId,
      sharedProspectId,
    };
  });
  const { targetLeadId } = seeded;

  const tablesBefore = new Set(
    (await rowsNaming(h, sourceLeadId)).map((row) => row.split(":")[0]),
  );
  expect([...tablesBefore].sort()).toEqual([
    "followUps",
    "leadGenAuditMatches",
    "leadIdentifiers",
    "leadNotes",
    "leads",
    "linkPortalLeadEdits",
    "meetingFormResponses",
    "operationsQualificationRows",
    "opportunities",
    "opportunitySearch",
    "slackQualificationEvents",
    "webhookDeliveries",
  ]);
  const statsBefore = await t.run((ctx) => ctx.db.query("tenantStats").first());

  await admin.mutation(api.leads.merge.mergeLead, { sourceLeadId, targetLeadId });
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  expect(await rowsNaming(h, sourceLeadId)).toEqual([]);

  const state = await t.run(async (ctx) => ({
    source: await ctx.db.get("leads", sourceLeadId),
    target: await ctx.db.get("leads", targetLeadId),
    earlier: await ctx.db.get("leads", seeded.earlierLeadId),
    targetOpportunitySearch: await ctx.db
      .query("opportunitySearch")
      .withIndex("by_opportunityId", (q) => q.eq("opportunityId", seeded.targetOpportunityId))
      .unique(),
    targetEventRow: await ctx.db
      .query("operationsQualificationRows")
      .withIndex("by_qualificationEventId", (q) =>
        q.eq("qualificationEventId", seeded.targetEventId),
      )
      .unique(),
    opportunity: await ctx.db.get("opportunities", booked.opportunityId),
    meeting: await ctx.db.get("meetings", booked.meetingId),
    deliveries: await ctx.db.query("webhookDeliveries").take(10),
    qualificationRows: await ctx.db.query("operationsQualificationRows").take(10),
    matches: await ctx.db.query("leadGenAuditMatches").take(10),
    sharedProspect: await ctx.db.get("leadGenProspects", seeded.sharedProspectId),
    searchRows: await ctx.db.query("leadCustomerSearchRows").take(10),
    stats: await ctx.db.query("tenantStats").first(),
    history: await ctx.db
      .query("leadMergeHistory")
      .withIndex("by_sourceLeadId", (q) => q.eq("sourceLeadId", sourceLeadId))
      .take(2),
  }));

  expect(state.source).toMatchObject({ status: "merged", mergedIntoLeadId: targetLeadId });
  // Chains stay one hop deep.
  expect(state.earlier).toMatchObject({ status: "merged", mergedIntoLeadId: targetLeadId });
  // The target keeps its own values and picks up the ones it lacked.
  expect(state.target).toMatchObject({
    fullName: "Sam Target",
    email: "target@example.com",
    phone: "+14165550142",
    country: "Canada",
    leadType: "pt",
  });
  expect(state.target?.customFields).toEqual({ city: "Vancouver", goal: "More clients" });
  expect(state.target?.customFieldLabels).toEqual({
    city: "Where are you based?",
    goal: "Main goal",
  });
  expect(state.target?.searchText).toContain("+14165550142");
  // The target's own rows pick up its new search text and phone.
  expect(state.targetOpportunitySearch?.searchText).toContain("source@example.com");
  expect(state.targetEventRow?.searchText).toContain("+14165550142");

  expect(state.opportunity?.leadId).toBe(targetLeadId);
  expect(state.opportunity?.potentialDuplicateLeadId).toBeUndefined();
  expect(state.meeting?.leadName).toBe("Sam Target");
  expect(state.deliveries.map((delivery) => delivery.leadId)).toEqual([
    targetLeadId,
    targetLeadId,
  ]);
  expect(state.qualificationRows.map((row) => row.leadId)).toEqual([
    targetLeadId,
    targetLeadId,
    targetLeadId,
  ]);
  expect(await countFormResponses(h, targetLeadId)).toBe(2);

  // The source's match for the shared prospect duplicated the target's, so
  // it is gone and the prospect points at the target's.
  expect(state.matches.map((row) => row._id).sort()).toEqual(
    [seeded.sourceMatchId, seeded.targetMatchId].sort(),
  );
  expect(state.sharedProspect?.currentAuditMatchId).toBe(seeded.targetMatchId);

  expect(state.searchRows.find((row) => row.leadId === sourceLeadId)).toMatchObject({
    lifecycle: "merged",
    isSearchVisible: false,
  });
  expect(state.searchRows.find((row) => row.leadId === targetLeadId)).toMatchObject({
    isSearchVisible: true,
    opportunityCount: 2,
  });
  expect(state.stats?.totalLeads).toBe((statsBefore?.totalLeads ?? 0) - 1);
  expect(state.history).toMatchObject([
    { targetLeadId, opportunitiesMoved: 1, meetingsMoved: 1 },
  ]);
});

it("clears every duplicate flag that names the source, past the first page", async () => {
  const h = await setup();
  const { t, tenantId, admin } = h;
  const ids = await t.run(async (ctx) => {
    const sourceLeadId = await insertLead(ctx, tenantId, { fullName: "Source" });
    const targetLeadId = await insertLead(ctx, tenantId, { fullName: "Target" });
    const otherLeadId = await insertLead(ctx, tenantId, { fullName: "Other" });
    // More flags than one page, on a lead outside the merge and on the target.
    for (let i = 0; i < 30; i += 1) {
      await insertOpportunity(ctx, tenantId, otherLeadId, {
        potentialDuplicateLeadId: sourceLeadId,
      });
    }
    await insertOpportunity(ctx, tenantId, targetLeadId, {
      potentialDuplicateLeadId: sourceLeadId,
    });
    return {
      sourceLeadId,
      targetLeadId,
      otherLeadId,
      // Moves onto the target, so its flag would name its own lead.
      flaggedWithTarget: await insertOpportunity(ctx, tenantId, sourceLeadId, {
        potentialDuplicateLeadId: targetLeadId,
      }),
      // Still a question about two other leads, so it stays.
      flaggedWithOther: await insertOpportunity(ctx, tenantId, sourceLeadId, {
        potentialDuplicateLeadId: otherLeadId,
      }),
    };
  });

  await admin.mutation(api.leads.merge.mergeLead, {
    sourceLeadId: ids.sourceLeadId,
    targetLeadId: ids.targetLeadId,
  });
  expect(await countFlagged(h, ids.sourceLeadId)).toBeGreaterThan(0);
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  expect(await countFlagged(h, ids.sourceLeadId)).toBe(0);
  // Clearing a flag is not activity on the other lead's deal.
  const otherOpportunities = await t.run((ctx) =>
    ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_leadId", (q) =>
        q.eq("tenantId", tenantId).eq("leadId", ids.otherLeadId),
      )
      .take(100),
  );
  expect(otherOpportunities.map((opportunity) => opportunity.updatedAt)).toEqual(
    otherOpportunities.map(() => AT),
  );
  const moved = await t.run(async (ctx) => ({
    flaggedWithTarget: await ctx.db.get("opportunities", ids.flaggedWithTarget),
    flaggedWithOther: await ctx.db.get("opportunities", ids.flaggedWithOther),
  }));
  expect(moved.flaggedWithTarget).toMatchObject({ leadId: ids.targetLeadId });
  expect(moved.flaggedWithTarget?.potentialDuplicateLeadId).toBeUndefined();
  expect(moved.flaggedWithOther).toMatchObject({
    leadId: ids.targetLeadId,
    potentialDuplicateLeadId: ids.otherLeadId,
  });
  expect(await rowsNaming(h, ids.sourceLeadId)).toEqual([]);
});

it("keeps the accepted audit match when the target's match for the same prospect was rejected", async () => {
  const h = await setup();
  const { t, tenantId, admin } = h;
  const ids = await t.run(async (ctx) => {
    const sourceLeadId = await insertLead(ctx, tenantId, { fullName: "Source" });
    const targetLeadId = await insertLead(ctx, tenantId, { fullName: "Target" });
    const sourceOpportunityId = await insertOpportunity(ctx, tenantId, sourceLeadId);
    const prospectId = await insertProspect(ctx, tenantId, "samboth");
    const rejectedId = await insertMatch(ctx, prospectId, targetLeadId, {
      matchStatus: "rejected",
      rejectedAt: AT,
      rejectionReason: "Wrong person",
    });
    const acceptedId = await insertMatch(ctx, prospectId, sourceLeadId, {
      opportunityId: sourceOpportunityId,
    });
    await ctx.db.patch("leadGenProspects", prospectId, { currentAuditMatchId: rejectedId });
    return { sourceLeadId, targetLeadId, prospectId, acceptedId };
  });

  await admin.mutation(api.leads.merge.mergeLead, {
    sourceLeadId: ids.sourceLeadId,
    targetLeadId: ids.targetLeadId,
  });

  const state = await t.run(async (ctx) => ({
    matches: await ctx.db.query("leadGenAuditMatches").take(10),
    prospect: await ctx.db.get("leadGenProspects", ids.prospectId),
  }));
  expect(state.matches).toHaveLength(1);
  expect(state.matches[0]).toMatchObject({
    _id: ids.acceptedId,
    leadId: ids.targetLeadId,
    matchStatus: "accepted",
  });
  expect(state.prospect?.currentAuditMatchId).toBe(ids.acceptedId);
});

it("links a booking to the newest accepted audit match when a merge left the lead several", async () => {
  const h = await setup();
  const { t, tenantId, admin } = h;
  const ids = await t.run(async (ctx) => {
    const sourceLeadId = await insertLead(ctx, tenantId, { fullName: "Source" });
    const targetLeadId = await insertLead(ctx, tenantId, { fullName: "Target" });
    const olderMatchId = await insertMatch(
      ctx,
      await insertProspect(ctx, tenantId, "samold"),
      targetLeadId,
    );
    const newerMatchId = await insertMatch(
      ctx,
      await insertProspect(ctx, tenantId, "samnew"),
      sourceLeadId,
    );
    return { sourceLeadId, targetLeadId, olderMatchId, newerMatchId };
  });
  await admin.mutation(api.leads.merge.mergeLead, {
    sourceLeadId: ids.sourceLeadId,
    targetLeadId: ids.targetLeadId,
  });

  const result = await t.run(async (ctx) => {
    const opportunityId = await insertOpportunity(ctx, tenantId, ids.targetLeadId);
    const linkedMatchId = await preserveQualificationAuditMatchForScheduledMeeting(ctx, {
      tenantId,
      leadId: ids.targetLeadId,
      opportunityId,
      now: AT,
    });
    return {
      opportunityId,
      linkedMatchId,
      older: await ctx.db.get("leadGenAuditMatches", ids.olderMatchId),
      newer: await ctx.db.get("leadGenAuditMatches", ids.newerMatchId),
    };
  });
  expect(result.linkedMatchId).toBe(ids.newerMatchId);
  expect(result.newer?.opportunityId).toBe(result.opportunityId);
  expect(result.older?.opportunityId).toBeUndefined();
});

it("links a booking to an unlinked accepted match before one that belongs to another deal", async () => {
  const h = await setup();
  const { t, tenantId } = h;
  const result = await t.run(async (ctx) => {
    const leadId = await insertLead(ctx, tenantId, { fullName: "Merged Lead" });
    const firstDealId = await insertOpportunity(ctx, tenantId, leadId);
    const unlinkedMatchId = await insertMatch(
      ctx,
      await insertProspect(ctx, tenantId, "older.unlinked"),
      leadId,
    );
    const linkedMatchId = await insertMatch(
      ctx,
      await insertProspect(ctx, tenantId, "newer.linked"),
      leadId,
      { opportunityId: firstDealId },
    );
    const secondDealId = await insertOpportunity(ctx, tenantId, leadId);
    const chosenId = await preserveQualificationAuditMatchForScheduledMeeting(ctx, {
      tenantId,
      leadId,
      opportunityId: secondDealId,
      now: AT,
    });
    return {
      chosenId,
      unlinkedMatchId,
      secondDealId,
      firstDealId,
      unlinked: await ctx.db.get("leadGenAuditMatches", unlinkedMatchId),
      linked: await ctx.db.get("leadGenAuditMatches", linkedMatchId),
    };
  });
  expect(result.chosenId).toBe(result.unlinkedMatchId);
  expect(result.unlinked?.opportunityId).toBe(result.secondDealId);
  expect(result.linked?.opportunityId).toBe(result.firstDealId);
});

it("finds the deal's own audit match even behind newer matches on the lead", async () => {
  const h = await setup();
  const { t, tenantId } = h;
  const result = await t.run(async (ctx) => {
    const leadId = await insertLead(ctx, tenantId, { fullName: "Many Matches" });
    const dealId = await insertOpportunity(ctx, tenantId, leadId);
    const ownMatchId = await insertMatch(
      ctx,
      await insertProspect(ctx, tenantId, "own.match"),
      leadId,
      { opportunityId: dealId },
    );
    const newerMatchIds = [];
    for (let index = 0; index < 6; index += 1) {
      newerMatchIds.push(
        await insertMatch(
          ctx,
          await insertProspect(ctx, tenantId, `newer.${index}`),
          leadId,
        ),
      );
    }
    const chosenId = await preserveQualificationAuditMatchForScheduledMeeting(ctx, {
      tenantId,
      leadId,
      opportunityId: dealId,
      now: AT,
    });
    const newer = await Promise.all(
      newerMatchIds.map((id) => ctx.db.get("leadGenAuditMatches", id)),
    );
    return { chosenId, ownMatchId, newer };
  });
  expect(result.chosenId).toBe(result.ownMatchId);
  expect(result.newer.map((match) => match?.opportunityId)).toEqual(
    Array(6).fill(undefined),
  );
});

it("rejects a source with more opportunities than one merge can move, and writes nothing", async () => {
  const h = await setup();
  const { t, tenantId, admin } = h;
  const ids = await t.run(async (ctx) => {
    const sourceLeadId = await insertLead(ctx, tenantId, { fullName: "Source" });
    const targetLeadId = await insertLead(ctx, tenantId, { fullName: "Target" });
    for (let i = 0; i <= OPPORTUNITY_LIMIT; i += 1) {
      await insertOpportunity(ctx, tenantId, sourceLeadId);
    }
    return { sourceLeadId, targetLeadId };
  });
  const before = await t.run(dumpTables);

  await expect(admin.mutation(api.leads.merge.mergeLead, ids)).rejects.toThrow(
    "lead.merge_too_many_opportunities",
  );

  expect(await t.run(dumpTables)).toEqual(before);
});

it("moves form responses past the first page in scheduled batches", async () => {
  const h = await setup();
  const { t, tenantId, admin } = h;
  const ids = await t.run(async (ctx) => {
    const sourceLeadId = await insertLead(ctx, tenantId, { fullName: "Source" });
    const targetLeadId = await insertLead(ctx, tenantId, { fullName: "Target" });
    await seedDeal(ctx, { tenantId, leadId: sourceLeadId, key: "paged", meetings: 5, formResponses: 90 });
    return { sourceLeadId, targetLeadId };
  });

  await admin.mutation(api.leads.merge.mergeLead, ids);
  // The merge moved the first page; the rest wait for the scheduled batches.
  expect(await countFormResponses(h, ids.sourceLeadId)).toBeGreaterThan(0);
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  expect(await countFormResponses(h, ids.sourceLeadId)).toBe(0);
  expect(await countFormResponses(h, ids.targetLeadId)).toBe(450);
  expect(await rowsNaming(h, ids.sourceLeadId)).toEqual([]);
});

it("merges a source at the opportunity bound into a busy target within Convex's transaction limits", async () => {
  const h = await setup({ transactionLimits: true });
  const { t, tenantId, admin } = h;
  const ids = await t.run(async (ctx) => ({
    sourceLeadId: await insertLead(ctx, tenantId, { fullName: "Source" }),
    targetLeadId: await insertLead(ctx, tenantId, { fullName: "Target" }),
    otherLeadId: await insertLead(ctx, tenantId, { fullName: "Other" }),
    installationId: await insertSlackInstallation(ctx, tenantId),
  }));
  // The source at the bound, a target and a third lead with 100 deals each
  // (as many as a lead/customer row rebuild reads), and 40 of the third
  // lead's deals flagged as duplicates of the source.
  for (let i = 0; i < 5 * OPPORTUNITY_LIMIT; i += 1) {
    const lead = i < OPPORTUNITY_LIMIT ? "source" : i < 3 * OPPORTUNITY_LIMIT ? "target" : "other";
    await t.run((ctx) =>
      seedDeal(ctx, {
        tenantId,
        leadId:
          lead === "source" ? ids.sourceLeadId : lead === "target" ? ids.targetLeadId : ids.otherLeadId,
        key: `deal-${i}`,
        meetings: lead === "source" ? 3 : 1,
        formResponses: 3,
        installationId: ids.installationId,
        padded: true,
        opportunity:
          lead === "other" && i % 5 !== 0 ? { potentialDuplicateLeadId: ids.sourceLeadId } : {},
      }),
    );
  }

  await admin.mutation(api.leads.merge.mergeLead, {
    sourceLeadId: ids.sourceLeadId,
    targetLeadId: ids.targetLeadId,
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  expect(await rowsNaming(h, ids.sourceLeadId)).toEqual([]);
  expect(await countFormResponses(h, ids.targetLeadId)).toBe(
    OPPORTUNITY_LIMIT * 3 * 3 + 2 * OPPORTUNITY_LIMIT * 3,
  );
});

it("merges as an operator only on behalf of a user who may merge", async () => {
  const h = await setup();
  const { t, tenantId } = h;
  const ids = await t.run(async (ctx) => ({
    sourceLeadId: await insertLead(ctx, tenantId, { fullName: "Sam One", email: "sam@x.com" }),
    targetLeadId: await insertLead(ctx, tenantId, { fullName: "Sam One" }),
    adminId: await userId(ctx, "user_admin"),
    otherTenantUserId: await ctx.db.insert("users", {
      tenantId: await ctx.db.insert("tenants", {
        companyName: "Other",
        contactEmail: "other@example.com",
        workosOrgId: "org_other",
        status: "active",
        inviteExpiresAt: 0,
        createdBy: "test",
      }),
      workosUserId: "user_other",
      email: "other@example.com",
      role: "tenant_admin",
      isActive: true,
    }),
  }));
  const sameTenantUser = (fields: Pick<Doc<"users">, "role" | "isActive">, workosUserId: string) =>
    t.run((ctx) =>
      ctx.db.insert("users", { tenantId, workosUserId, email: `${workosUserId}@example.com`, ...fields }),
    );
  const inactiveAdminId = await sameTenantUser({ role: "tenant_admin", isActive: false }, "user_inactive");
  const leadGeneratorId = await sameTenantUser({ role: "lead_generator", isActive: true }, "user_lead_gen");
  const args = { tenantId, sourceLeadId: ids.sourceLeadId, targetLeadId: ids.targetLeadId };
  // Another tenant's admin, an inactive admin, and a role that can't merge.
  for (const actorUserId of [ids.otherTenantUserId, inactiveAdminId, leadGeneratorId]) {
    await expect(
      t.mutation(internal.leads.merge.mergeLeadAsOperator, { ...args, actorUserId }),
    ).rejects.toThrow("The actor must be an active user who can merge leads");
  }

  await t.mutation(internal.leads.merge.mergeLeadAsOperator, { ...args, actorUserId: ids.adminId });
  const state = await t.run(async (ctx) => ({
    source: await ctx.db.get("leads", ids.sourceLeadId),
    target: await ctx.db.get("leads", ids.targetLeadId),
    history: await ctx.db.query("leadMergeHistory").take(5),
  }));
  expect(state.source).toMatchObject({ status: "merged", mergedIntoLeadId: ids.targetLeadId });
  // The target lacked an email, so the source's carries over, as in a merge from the app.
  expect(state.target?.email).toBe("sam@x.com");
  expect(state.history).toMatchObject([{ mergedByUserId: ids.adminId }]);
});

it("keeps a moved deal's activity time, and restores one a merge set", async () => {
  const h = await setup();
  const { t, tenantId, admin } = h;
  const ids = await t.run(async (ctx) => {
    const sourceLeadId = await insertLead(ctx, tenantId, { fullName: "Sam One", email: "sam@x.com" });
    const targetLeadId = await insertLead(ctx, tenantId, { fullName: "Sam One" });
    const opportunityId = await insertOpportunity(ctx, tenantId, sourceLeadId);
    return { sourceLeadId, targetLeadId, opportunityId };
  });
  const before = await t.run((ctx) => ctx.db.get("opportunities", ids.opportunityId));
  await admin.mutation(api.leads.merge.mergeLead, { sourceLeadId: ids.sourceLeadId, targetLeadId: ids.targetLeadId });
  const moved = await t.run((ctx) => ctx.db.get("opportunities", ids.opportunityId));
  // Moving a deal to another lead isn't activity on it.
  expect(moved).toMatchObject({ leadId: ids.targetLeadId, updatedAt: before!.updatedAt });

  // A deal a merge stamped before this change gets its time back.
  const mergedAt = (await t.run((ctx) => ctx.db.query("leadMergeHistory").take(1)))[0].mergedAt;
  await t.run((ctx) =>
    ctx.db.patch("opportunities", ids.opportunityId, { updatedAt: mergedAt, latestActivityAt: mergedAt }),
  );
  const restore = (updatedAt: number) =>
    t.mutation(internal.leads.merge.restoreMergedActivityTime, { tenantId, opportunityId: ids.opportunityId, updatedAt });
  await expect(restore(mergedAt + 1)).rejects.toThrow("The restored time must be earlier");
  await expect(restore(Number.NaN)).rejects.toThrow("The restored time must be finite");
  await restore(before!.updatedAt);
  const restored = await t.run(async (ctx) => ({
    opportunity: await ctx.db.get("opportunities", ids.opportunityId),
    projection: await ctx.db
      .query("opportunitySearch")
      .withIndex("by_opportunityId", (q) => q.eq("opportunityId", ids.opportunityId))
      .unique(),
  }));
  // The activity time and the search row that sorts by it follow.
  expect(restored.opportunity).toMatchObject({ updatedAt: before!.updatedAt, latestActivityAt: before!.updatedAt });
  expect(restored.projection?.latestActivityAt).toBe(before!.updatedAt);
  // Once restored, the deal's time is no longer a merge's write.
  await expect(restore(before!.updatedAt - 1)).rejects.toThrow("The deal's last update isn't a merge's write");
});
