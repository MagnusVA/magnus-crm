/**
 * Polluted-lead split, phases 1 to 4 (docs/plans/polluted-lead-split.md):
 * discovery, invitee snapshots, plan building, and approval. Nothing here
 * writes outside the staging tables.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import { bookingHarness } from "../../tests/bookingHarness";
import {
  AT,
  DAY,
  book,
  build,
  describePlan,
  discover,
  insertIdentifier,
  insertLead,
  insertOpportunity,
  person,
  planFor,
  seedTierA,
  setup,
  snapshot,
} from "../../tests/leadSplitFixtures";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("discover", () => {
  it("drafts a plan for each lead with two people, and only reports the rest", async () => {
    const harness = await setup();
    const { leadId } = await seedTierA(harness);
    const { t, tenantId } = harness;
    const ids = await t.run(async (ctx) => {
      // One person behind a placeholder email: cleanup only (Tier D).
      const tierD = await insertLead(ctx, tenantId, { email: "email@yahoo.com" });
      await book(ctx, {
        tenantId,
        leadId: tierD,
        opportunityId: await insertOpportunity(ctx, tenantId, tierD),
      }, { day: 2, email: "email@yahoo.com", phoneAnswer: "7789559253" });
      // One person with two emails joined by a phone: an alias, nothing to split.
      const alias = await insertLead(ctx, tenantId, { email: "ann@x.com" });
      const aliasDeal = await insertOpportunity(ctx, tenantId, alias);
      await book(ctx, { tenantId, leadId: alias, opportunityId: aliasDeal }, {
        day: 2, email: "ann@x.com", phoneAnswer: "6045550101",
      });
      await book(ctx, { tenantId, leadId: alias, opportunityId: aliasDeal }, {
        day: 4, email: "ann.work@x.com", phoneAnswer: "6045550101",
      });
      // Two people, no placeholder (Tier B), on the staff allowlist.
      const staff = await insertLead(ctx, tenantId, { email: "staff@x.com" });
      const staffDeal = await insertOpportunity(ctx, tenantId, staff);
      await book(ctx, { tenantId, leadId: staff, opportunityId: staffDeal }, { day: 2, email: "staff@x.com" });
      await book(ctx, { tenantId, leadId: staff, opportunityId: staffDeal }, { day: 4, email: "tester@x.com" });
      return { tierD, alias, staff };
    });

    const preview = await t.action(internal.leadSplit.discover.discover, {
      tenantId,
      dryRun: true,
      excludeLeadIds: [ids.staff],
      pageSize: 2,
    });
    expect(preview.created).toBe(0);
    expect(
      Object.fromEntries(preview.candidates.map((candidate) => [candidate.leadId, candidate.tier])),
    ).toEqual({ [leadId]: "A", [ids.tierD]: "D", [ids.alias]: "alias" });
    expect(await t.run((ctx) => ctx.db.query("leadSplitPlans").take(10))).toHaveLength(0);

    const first = await discover(harness, [ids.staff]);
    expect([first.created, first.existing]).toEqual([1, 0]);
    expect(await planFor(harness, leadId)).toMatchObject({
      tier: "A",
      status: "draft",
      planVersion: 0,
      discoveryReasons: ["placeholder_key", "multiple_clusters", "multiple_booking_emails"],
    });
    const again = await discover(harness, [ids.staff]);
    expect([again.created, again.existing]).toEqual([0, 1]);
  });
});

describe("transaction limits", () => {
  it("discovers and builds a lead the size of the largest polluted one", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T00:00:00Z"));
    const harness = await bookingHarness({ transactionLimits: true });
    const { t, tenantId } = harness;
    const PEOPLE = 53;
    const DEALS = 28;
    const MEETINGS = 65;
    const leadId = await t.run(async (ctx) => {
      const leadId = await insertLead(ctx, tenantId, { email: "person0@x.com" });
      const deals = [];
      for (let d = 0; d < DEALS; d += 1) {
        deals.push(await insertOpportunity(ctx, tenantId, leadId, { notes: "x".repeat(1_200) }));
      }
      for (let m = 0; m < MEETINGS; m += 1) {
        const p = m % PEOPLE;
        const meetingId = await book(ctx, { tenantId, leadId, opportunityId: deals[m % DEALS] }, {
          day: m,
          email: m < PEOPLE ? `person${p}@x.com` : undefined,
          identifierPhone: m === 0 ? "+12345678910" : undefined,
          phoneAnswer: "+1 234-567-8910",
          instagramAnswer: `person${p}`,
        });
        for (let r = 0; r < 5; r += 1) {
          await ctx.db.insert("meetingFormResponses", {
            tenantId,
            meetingId,
            opportunityId: deals[m % DEALS],
            leadId,
            fieldKey: `q_extra_${r}`,
            questionLabelSnapshot: `Question ${r}`,
            answerText: "x".repeat(200),
            capturedAt: AT,
          });
        }
        await snapshot(ctx, tenantId, meetingId, { email: `person${p}@x.com`, name: `Person ${p}` });
      }
      return leadId;
    });

    await discover(harness);
    const plan = await planFor(harness, leadId);
    const built = await build(harness, plan._id);
    expect(built.totals).toMatchObject({ persons: PEOPLE, newLeads: PEOPLE - 1 });
    const described = await describePlan(harness, plan._id);
    expect(described.persons).toHaveLength(PEOPLE);
  });
});

describe("snapshot storage", () => {
  it("lists each meeting once and never replaces a good snapshot with a failure", async () => {
    const harness = await setup();
    const { leadId, meetings } = await seedTierA(harness, { snapshots: false });
    await discover(harness);
    const plan = await planFor(harness, leadId);
    const { t, tenantId } = harness;

    const before = await t.query(internal.leadSplit.snapshotStore.getSnapshotTargets, { planId: plan._id });
    expect(before.targets.map((target) => target.meetingId)).toEqual([
      meetings.paula,
      meetings.pedro,
      meetings.pia,
    ]);

    const uri = before.targets[0].inviteeUri;
    const save = (outcome: "ok" | "http_error") =>
      t.mutation(internal.leadSplit.snapshotStore.saveInviteeSnapshots, {
        tenantId,
        snapshots: [
          { meetingId: meetings.paula, inviteeUri: uri, outcome, email: outcome === "ok" ? "paula@x.com" : undefined, fetchedAt: 1 },
        ],
      });
    expect(await save("ok")).toEqual({ written: 1, kept: 0 });
    expect(await save("http_error")).toEqual({ written: 0, kept: 1 });
    const after = await t.query(internal.leadSplit.snapshotStore.getSnapshotTargets, { planId: plan._id });
    expect(after.targets[0].snapshotOutcome).toBe("ok");
  });

  it("fetches each invitee from Calendly and stores it", async () => {
    const harness = await setup();
    const { leadId, meetings } = await seedTierA(harness, { snapshots: false });
    await discover(harness);
    const plan = await planFor(harness, leadId);
    const { t, tenantId } = harness;
    await t.run(async (ctx) => {
      await ctx.db.insert("tenantCalendlyConnections", {
        tenantId,
        calendlyAccessToken: "access-token",
        calendlyTokenExpiresAt: Date.now() + 365 * DAY,
      });
    });
    const fetchFn = vi.fn(async (url: string) =>
      url.includes(`-${3}/`)
        ? new Response("{}", { status: 404 })
        : new Response(JSON.stringify({ resource: { email: "Someone@X.com", name: "Some One" } }), {
            status: 200,
          }),
    );
    vi.stubGlobal("fetch", fetchFn);

    const dry = await t.action(internal.leadSplit.snapshot.fetchInvitees, {
      planId: plan._id,
      dryRun: true,
      limit: 1,
    });
    expect(dry).toMatchObject({ fetched: 1, ok: 1 });
    expect(await t.run((ctx) => ctx.db.query("leadSplitInviteeSnapshots").take(10))).toHaveLength(0);

    const result = await t.action(internal.leadSplit.snapshot.fetchInvitees, {
      planId: plan._id,
      dryRun: false,
    });
    expect(result).toMatchObject({ meetings: 3, fetched: 3, ok: 2, notFound: 1, failedMeetingIds: [meetings.pedro] });
    const stored = await t.run((ctx) => ctx.db.query("leadSplitInviteeSnapshots").take(10));
    expect(stored.find((row) => row.meetingId === meetings.paula)).toMatchObject({
      outcome: "ok",
      email: "someone@x.com",
      name: "Some One",
    });
    for (const [url, init] of fetchFn.mock.calls as unknown as [string, RequestInit][]) {
      expect(url).toMatch(/^https:\/\/api\.calendly\.com\/scheduled_events\/[^/]+\/invitees\/i$/);
      expect(init.redirect).toBe("error");
    }

    // A rerun only retries the meeting without a good snapshot.
    fetchFn.mockClear();
    await t.action(internal.leadSplit.snapshot.fetchInvitees, { planId: plan._id, dryRun: false });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("buildPlan", () => {
  it("splits a Tier A lead by person, deal and identifier", async () => {
    const harness = await setup();
    const { leadId, piaLeadId, mixed, whole, meetings } = await seedTierA(harness);
    await discover(harness);
    const plan = await planFor(harness, leadId);

    const built = await build(harness, plan._id);
    expect(built).toMatchObject({
      planVersion: 1,
      status: "draft",
      tier: "A",
      flags: [],
      totals: {
        persons: 3,
        newLeads: 1,
        mergeIns: 1,
        opportunitiesMovedWhole: 1,
        splitOpportunities: 1,
        newOpportunities: 1,
        keptDocumentStatusChanges: 0,
        meetingsChangingOpportunity: 1,
        meetingsChangingLead: 2,
        identifiersMoved: 1,
        placeholderIdentifiers: 1,
        movedWithoutEmail: 1,
      },
    });

    const described = await describePlan(harness, plan._id);
    const paula = person(described, meetings.paula);
    const pedro = person(described, meetings.pedro);
    const pia = person(described, meetings.pia);
    expect(paula).toMatchObject({
      personKey: `p_${meetings.paula}`,
      role: "original",
      identifiers: 1,
      opportunities: [
        { opportunityId: mixed, kind: "split_new", meetings: 1, statusAtBuild: "no_show", status: "canceled" },
      ],
    });
    // O1: the latest meeting's person keeps the document and its status.
    expect(pedro).toMatchObject({
      role: "new",
      hasEmail: true,
      opportunities: [{ opportunityId: mixed, kind: "keep_document", status: "no_show" }],
    });
    // Rule 3: Pia's handle already resolves to her own lead.
    expect(pia).toMatchObject({
      role: "merge_into",
      targetLeadId: piaLeadId,
      hasEmail: false,
      hasName: true,
      opportunities: [{ opportunityId: whole, kind: "whole", status: "scheduled" }],
    });

    const pedroRow = await harness.t.run((ctx) =>
      ctx.db
        .query("leadSplitPersons")
        .withIndex("by_planId_and_personKey", (q) => q.eq("planId", plan._id).eq("personKey", pedro.personKey))
        .unique(),
    );
    expect(pedroRow?.canonical).toEqual({ email: "pedro@x.com", fullName: "Pedro Two", customFieldsMeetingId: meetings.pedro });

    // The operator may approve a clean Tier A plan, at the version reviewed.
    await expect(
      harness.t.mutation(internal.leadSplit.plan.approve, { planId: plan._id, planVersion: 2, reviewer: "operator" }),
    ).rejects.toThrow("Plan is at version 1, not 2");
    await harness.t.mutation(internal.leadSplit.plan.approve, { planId: plan._id, planVersion: 1, reviewer: "operator" });
    expect(await planFor(harness, leadId)).toMatchObject({ status: "approved", approvedBy: "operator" });

    // A rebuild replaces the persons and clears the approval.
    const rebuilt = await build(harness, plan._id);
    expect(rebuilt).toMatchObject({ planVersion: 2, status: "draft" });
    expect((await planFor(harness, leadId)).approvedBy).toBeUndefined();
    expect(
      await harness.t.run((ctx) =>
        ctx.db
          .query("leadSplitPersons")
          .withIndex("by_planId_and_personKey", (q) => q.eq("planId", plan._id))
          .take(10),
      ),
    ).toHaveLength(3);
  });

  it("writes nothing on a dry run", async () => {
    const harness = await setup();
    const { leadId } = await seedTierA(harness);
    await discover(harness);
    const plan = await planFor(harness, leadId);

    const preview = await harness.t.mutation(internal.leadSplit.plan.buildPlan, {
      planId: plan._id,
      dryRun: true,
    });
    expect(preview).toMatchObject({ dryRun: true, planVersion: 0, status: "draft", totals: { persons: 3 } });
    const unchanged = await planFor(harness, leadId);
    expect([unchanged.planVersion, unchanged.builtAt]).toEqual([0, undefined]);
    expect(await harness.t.run((ctx) => ctx.db.query("leadSplitPersons").take(10))).toHaveLength(0);
  });

  it("needs review when a meeting has no invitee snapshot", async () => {
    const harness = await setup();
    const { leadId, meetings } = await seedTierA(harness, { snapshots: false });
    await discover(harness);
    const plan = await planFor(harness, leadId);

    const built = await build(harness, plan._id);
    expect(built).toMatchObject({ status: "needs_review", flags: ["snapshot_missing"], blockingFlags: [] });
    const described = await describePlan(harness, plan._id);
    expect(described.flagDetails.map((detail) => detail.meetingId)).toEqual([
      meetings.paula,
      meetings.pedro,
      meetings.pia,
    ]);
    await expect(
      harness.t.mutation(internal.leadSplit.plan.approve, { planId: plan._id, planVersion: 1, reviewer: " " }),
    ).rejects.toThrow("Name the reviewer");
  });

  it("keeps a Slack deal with the person its Slack event names", async () => {
    const harness = await setup();
    const { t, tenantId } = harness;
    const seeded = await t.run(async (ctx) => {
      const leadId = await insertLead(ctx, tenantId, { country: "US" });
      const installationId = await ctx.db.insert("slackInstallations", {
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
      const qualifiedBy = { slackUserId: "U1", slackTeamId: "T1", submittedAt: AT };
      const deal = await insertOpportunity(ctx, tenantId, leadId, {
        source: "slack_qualified",
        status: "no_show",
        qualifiedBy,
      });
      const eventId = await ctx.db.insert("slackQualificationEvents", {
        tenantId,
        installationId,
        leadId,
        opportunityId: deal,
        resultKind: "already_booked",
        qualifiedBy,
        slackUserId: "U1",
        slackTeamId: "T1",
        fullNameSnapshot: "Sam",
        platform: "instagram",
        handleSnapshot: "@SamOne",
        submittedAt: AT,
        createdAt: AT,
      });
      const sam = await book(ctx, { tenantId, leadId, opportunityId: deal }, {
        day: 1,
        status: "canceled",
        email: "sam@x.com",
        identifierPhone: "+12342342342",
        instagramAnswer: "samone",
      });
      const tom = await book(ctx, { tenantId, leadId, opportunityId: deal }, {
        day: 3,
        status: "no_show",
        email: "tom@x.com",
        instagramAnswer: "tomtwo",
      });
      await snapshot(ctx, tenantId, sam, { email: "sam@x.com", name: "Sam One" });
      await snapshot(ctx, tenantId, tom, { email: "tom@x.com", name: "Tom Two" });
      return { leadId, deal, eventId, sam, tom };
    });
    await discover(harness);
    const plan = await planFor(harness, seeded.leadId);

    const built = await build(harness, plan._id);
    expect(built).toMatchObject({
      status: "needs_review",
      flags: ["slack_fields_review"],
      totals: { keptDocumentStatusChanges: 1 },
    });
    const described = await describePlan(harness, plan._id);
    expect(person(described, seeded.sam)).toMatchObject({
      role: "original",
      slackEventIds: [seeded.eventId],
      // The keeper's own last meeting was canceled (lead_split exception).
      opportunities: [{ kind: "keep_document", statusAtBuild: "no_show", status: "canceled" }],
    });
    expect(person(described, seeded.tom)).toMatchObject({
      role: "new",
      opportunities: [{ kind: "split_new", status: "no_show", inheritsOutcome: true }],
    });
    expect(described.slackFieldsPersonKey).toBe(`p_${seeded.sam}`);
    await t.mutation(internal.leadSplit.plan.approve, { planId: plan._id, planVersion: 1, reviewer: "Reviewer Name" });
  });

  it("leaves a converted lead's customer, and a reused email, with the buyer", async () => {
    const harness = await setup();
    const { t, tenantId } = harness;
    const seeded = await t.run(async (ctx) => {
      const leadId = await insertLead(ctx, tenantId, { status: "converted", email: "shared@x.com" });
      const july = await insertOpportunity(ctx, tenantId, leadId, { status: "canceled" });
      const october = await insertOpportunity(ctx, tenantId, leadId, { status: "payment_received" });
      const julyMeeting = await book(ctx, { tenantId, leadId, opportunityId: july }, {
        day: 1,
        status: "canceled",
        email: "shared@x.com",
        phoneAnswer: "7789559253",
        instagramAnswer: "julyperson",
      });
      const octoberMeeting = await book(ctx, { tenantId, leadId, opportunityId: october }, {
        day: 100,
        status: "completed",
        phoneAnswer: "6045550101",
        instagramAnswer: "octperson",
      });
      await snapshot(ctx, tenantId, julyMeeting, { email: "shared@x.com", name: "July Person" });
      await snapshot(ctx, tenantId, octoberMeeting, { email: "shared@x.com", name: "October Buyer" });
      const adminId = (await ctx.db
        .query("users")
        .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
        .take(10)).find((user) => user.role === "tenant_admin")!._id;
      const programId = await ctx.db.insert("tenantPrograms", {
        tenantId,
        name: "Program",
        normalizedName: "program",
        createdAt: AT,
        createdByUserId: adminId,
        updatedAt: AT,
      });
      await ctx.db.insert("customers", {
        tenantId,
        leadId,
        fullName: "October Buyer",
        email: "shared@x.com",
        convertedAt: AT + 100 * DAY,
        convertedByUserId: adminId,
        winningOpportunityId: october,
        winningMeetingId: octoberMeeting,
        programId,
        programName: "Program",
        status: "active",
        createdAt: AT + 100 * DAY,
      });
      return { leadId, julyMeeting, octoberMeeting };
    });
    await discover(harness);
    const plan = await planFor(harness, seeded.leadId);
    expect(plan.tier).toBe("B");

    const built = await build(harness, plan._id);
    expect(built).toMatchObject({ status: "needs_review", flags: ["shared_email"], blockingFlags: [] });
    const described = await describePlan(harness, plan._id);
    const buyer = person(described, seeded.octoberMeeting);
    const july = person(described, seeded.julyMeeting);
    expect(buyer).toMatchObject({ role: "original", hasEmail: true, identifiers: 1 });
    // Q5: the person split off a shared email gets no email.
    expect(july).toMatchObject({ role: "new", hasEmail: false, identifiers: 0 });
  });

  it("applies reviewer merges and skips, and blocks on a stale one", async () => {
    const harness = await setup();
    const { leadId, piaLeadId, mixed, meetings } = await seedTierA(harness);
    await discover(harness);
    const plan = await planFor(harness, leadId);
    const pedroKey = `p_${meetings.pedro}`;
    const piaKey = `p_${meetings.pia}`;

    await build(harness, plan._id, { overrides: { merges: [[pedroKey, piaKey]] } });
    let described = await describePlan(harness, plan._id);
    expect(described.persons).toHaveLength(2);
    expect(person(described, meetings.pia)).toMatchObject({
      personKey: pedroKey,
      candidateKeys: [pedroKey, piaKey],
      role: "merge_into",
      targetLeadId: piaLeadId,
    });

    // Overrides are stored and reapplied; a skip folds a person into the original.
    await build(harness, plan._id, { overrides: { skips: [pedroKey] } });
    described = await describePlan(harness, plan._id);
    expect(person(described, meetings.pedro)).toMatchObject({
      role: "original",
      opportunities: expect.arrayContaining([
        expect.objectContaining({ opportunityId: mixed, kind: "whole", meetings: 2, status: "no_show" }),
      ]),
    });
    await build(harness, plan._id);
    expect((await describePlan(harness, plan._id)).overrides).toEqual({ skips: [pedroKey] });

    const stale = await build(harness, plan._id, { overrides: { merges: [["p_gone", pedroKey]] } });
    expect(stale).toMatchObject({ status: "needs_review", blockingFlags: ["stale_override"] });
    await expect(
      harness.t.mutation(internal.leadSplit.plan.approve, {
        planId: plan._id,
        planVersion: stale.planVersion,
        reviewer: "Reviewer Name",
      }),
    ).rejects.toThrow("Plan has blocking flags: stale_override");
  });

  it("gives a meeting without keys to its deal's person, until a reviewer separates it", async () => {
    const harness = await setup();
    const { t, tenantId } = harness;
    const seeded = await t.run(async (ctx) => {
      const leadId = await insertLead(ctx, tenantId, { email: "email@gmail.com" });
      const deal = await insertOpportunity(ctx, tenantId, leadId);
      const keyless = await book(ctx, { tenantId, leadId, opportunityId: deal }, { day: 0, status: "canceled" });
      const ana = await book(ctx, { tenantId, leadId, opportunityId: deal }, { day: 2, email: "ana@x.com" });
      const other = await book(ctx, {
        tenantId,
        leadId,
        opportunityId: await insertOpportunity(ctx, tenantId, leadId),
      }, { day: 4, email: "bo@x.com" });
      return { leadId, deal, keyless, ana, other };
    });
    await discover(harness);
    const plan = await planFor(harness, seeded.leadId);

    await build(harness, plan._id);
    let described = await describePlan(harness, plan._id);
    expect(person(described, seeded.keyless)).toMatchObject({
      personKey: `p_${seeded.ana}`,
      meetingIds: [seeded.keyless, seeded.ana],
    });
    expect(described.flagDetails).toContainEqual({ flag: "unattributed_meeting", meetingId: seeded.keyless });

    await build(harness, plan._id, { overrides: { separate: [[seeded.keyless]] } });
    described = await describePlan(harness, plan._id);
    expect(described.persons).toHaveLength(3);
    expect(person(described, seeded.keyless)).toMatchObject({
      personKey: `p_${seeded.keyless}`,
      opportunities: [{ opportunityId: seeded.deal, kind: "split_new", status: "canceled" }],
    });
    expect(person(described, seeded.ana).opportunities).toMatchObject([
      { opportunityId: seeded.deal, kind: "keep_document" },
    ]);
  });

  it("flags a Slack deal whose keeper would change status other than no-show to canceled", async () => {
    const harness = await setup();
    const { t, tenantId } = harness;
    const leadId = await t.run(async (ctx) => {
      const leadId = await insertLead(ctx, tenantId);
      const installationId = await ctx.db.insert("slackInstallations", {
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
      const qualifiedBy = { slackUserId: "U1", slackTeamId: "T1", submittedAt: AT };
      // scheduled -> canceled is a valid move, but not the split's to make.
      const deal = await insertOpportunity(ctx, tenantId, leadId, {
        source: "slack_qualified",
        status: "scheduled",
        qualifiedBy,
      });
      await ctx.db.insert("slackQualificationEvents", {
        tenantId,
        installationId,
        leadId,
        opportunityId: deal,
        resultKind: "already_booked",
        qualifiedBy,
        slackUserId: "U1",
        slackTeamId: "T1",
        fullNameSnapshot: "Nobody",
        platform: "instagram",
        handleSnapshot: "nobodyhere",
        submittedAt: AT,
        createdAt: AT,
      });
      await book(ctx, { tenantId, leadId, opportunityId: deal }, {
        day: 1, status: "canceled", email: "sam@x.com", identifierPhone: "+12342342342",
      });
      await book(ctx, { tenantId, leadId, opportunityId: deal }, { day: 3, email: "tom@x.com" });
      return leadId;
    });
    await discover(harness);
    const plan = await planFor(harness, leadId);
    const built = await build(harness, plan._id);
    expect(built.flags).toEqual(expect.arrayContaining(["outcome_review", "slack_event_mismatch"]));
    expect(built.blockingFlags).toEqual(["outcome_review"]);
  });

  it("blocks a split that leaves a completed meeting without its deal", async () => {
    const harness = await setup();
    const { t, tenantId } = harness;
    const leadId = await t.run(async (ctx) => {
      const leadId = await insertLead(ctx, tenantId);
      const deal = await insertOpportunity(ctx, tenantId, leadId, { status: "scheduled" });
      await book(ctx, { tenantId, leadId, opportunityId: deal }, {
        day: 1, status: "completed", email: "first@x.com", identifierPhone: "+12345678901",
      });
      await book(ctx, { tenantId, leadId, opportunityId: deal }, { day: 3, email: "second@x.com" });
      return leadId;
    });
    await discover(harness);
    const plan = await planFor(harness, leadId);
    const built = await build(harness, plan._id);
    expect(built.blockingFlags).toEqual(["outcome_review"]);
  });

  it("blocks a person whose keys match two other leads until a reviewer picks one", async () => {
    const harness = await setup();
    const { t, tenantId } = harness;
    const seeded = await t.run(async (ctx) => {
      const leadId = await insertLead(ctx, tenantId);
      const byHandle = await insertLead(ctx, tenantId);
      const byPhone = await insertLead(ctx, tenantId);
      await insertIdentifier(ctx, tenantId, byHandle, "instagram", "twoleads");
      await insertIdentifier(ctx, tenantId, byPhone, "phone", "+16045550101");
      await book(ctx, { tenantId, leadId, opportunityId: await insertOpportunity(ctx, tenantId, leadId) }, {
        day: 1, email: "first@x.com", identifierPhone: "+12345678901",
      });
      const moved = await book(ctx, { tenantId, leadId, opportunityId: await insertOpportunity(ctx, tenantId, leadId) }, {
        day: 3, instagramAnswer: "twoleads", phoneAnswer: "6045550101",
      });
      return { leadId, byHandle, byPhone, moved };
    });
    await discover(harness);
    const plan = await planFor(harness, seeded.leadId);
    const built = await build(harness, plan._id);
    expect(built.blockingFlags).toEqual(["merge_target_ambiguous"]);
    let described = await describePlan(harness, plan._id);
    expect(person(described, seeded.moved)).toMatchObject({ role: "new" });
    expect(person(described, seeded.moved).mergeCandidateLeadIds).toHaveLength(2);

    const personKey = `p_${seeded.moved}`;
    const picked = await build(harness, plan._id, {
      overrides: { mergeTargets: [{ personKey, targetLeadId: seeded.byHandle }] },
    });
    expect(picked.blockingFlags).toEqual([]);
    described = await describePlan(harness, plan._id);
    expect(person(described, seeded.moved)).toMatchObject({ role: "merge_into", targetLeadId: seeded.byHandle });

    // No target means a new lead, even though the keys match.
    await build(harness, plan._id, { overrides: { mergeTargets: [{ personKey }] } });
    described = await describePlan(harness, plan._id);
    expect(person(described, seeded.moved)).toMatchObject({ role: "new", mergeCandidateLeadIds: [] });
  });

  it("gives a shared email to the first person who booked with it", async () => {
    const harness = await setup();
    const { t, tenantId } = harness;
    const seeded = await t.run(async (ctx) => {
      const leadId = await insertLead(ctx, tenantId, { email: "olga@x.com" });
      const deal = (day: number) => insertOpportunity(ctx, tenantId, leadId, { createdAt: AT + day * DAY });
      const olga = await book(ctx, { tenantId, leadId, opportunityId: await deal(0) }, {
        day: 0, email: "olga@x.com", phoneAnswer: "4165550100",
      });
      const xavi = await book(ctx, { tenantId, leadId, opportunityId: await deal(1) }, {
        day: 10, email: "xavi@x.com", phoneAnswer: "7789559253",
      });
      const yara = await book(ctx, { tenantId, leadId, opportunityId: await deal(2) }, {
        day: 20, email: "shared@x.com", phoneAnswer: "6045550101",
      });
      // Xavi books again with Yara's email; his phone joins it to him.
      const xaviAgain = await book(ctx, { tenantId, leadId, opportunityId: await deal(3) }, {
        day: 30, phoneAnswer: "7789559253",
      });
      await snapshot(ctx, tenantId, olga, { email: "olga@x.com", name: "Olga" });
      await snapshot(ctx, tenantId, xavi, { email: "xavi@x.com", name: "Xavi" });
      await snapshot(ctx, tenantId, yara, { email: "shared@x.com", name: "Yara" });
      await snapshot(ctx, tenantId, xaviAgain, { email: "shared@x.com", name: "Xavi" });
      return { leadId, xavi, yara };
    });
    await discover(harness);
    const plan = await planFor(harness, seeded.leadId);
    expect((await build(harness, plan._id)).flags).toEqual(["shared_email"]);
    const described = await describePlan(harness, plan._id);
    expect(person(described, seeded.yara)).toMatchObject({ role: "new", identifiers: 1, hasEmail: true });
    expect(person(described, seeded.xavi)).toMatchObject({ role: "new", identifiers: 1, hasEmail: true });
    const xaviRow = await t.run((ctx) =>
      ctx.db
        .query("leadSplitPersons")
        .withIndex("by_planId_and_personKey", (q) => q.eq("planId", plan._id).eq("personKey", `p_${seeded.xavi}`))
        .unique(),
    );
    expect(xaviRow?.canonical.email).toBe("xavi@x.com");
  });
});
