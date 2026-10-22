import { expect, it } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { rebuildQualificationRow } from "./projections";
import { bookingHarness, qualifiedLifecycle } from "../../tests/bookingHarness";
import { stageFields } from "../../tests/dealStageFixtures";
import {
  type BookingFixture,
  insertAttributionTeam,
  insertBooking,
  insertDmCloser,
} from "../../tests/bookingCreditFixtures";

// docs/plans/phase-3-attribution.md §6.2: a qualification row shows its deal's
// first external booking's team and DM closer, and that booking's resolution.

const QUALIFIED_AT = Date.parse("2026-09-01T12:00:00Z");
const FIRST_BOOKING_AT = Date.parse("2026-09-03T12:00:00Z");
const WINDOW = {
  qualifiedAfter: Date.parse("2026-09-01T00:00:00Z"),
  qualifiedBefore: Date.parse("2026-10-01T00:00:00Z"),
};
const SCHEDULED = {
  scheduledFrom: Date.parse("2026-09-01T00:00:00Z"),
  scheduledTo: Date.parse("2026-10-01T00:00:00Z"),
};

type Harness = Awaited<ReturnType<typeof bookingHarness>>;

async function seed(harness: Harness) {
  const { t, tenantId } = harness;
  return await t.run(async (ctx) => {
    const users = await ctx.db
      .query("users")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .take(10);
    const closer = users.find((user) => user.role === "closer");
    const admin = users.find((user) => user.role === "tenant_admin");
    if (!closer || !admin) throw new Error("Fixture users missing");

    const installationId = await ctx.db.insert("slackInstallations", {
      tenantId, teamId: "T1", teamName: "Team", isEnterpriseInstall: false, appId: "A1",
      botUserId: "B1", botAccessToken: "xoxb", scopes: [], notifyChannelId: "C1",
      notifyChannelName: "qualified", installedByWorkosUserId: "user_slack",
      installedAt: 0, tokenExpiresAt: 0, refreshToken: "r", status: "active",
    });
    await ctx.db.insert("slackUsers", {
      tenantId, installationId, slackUserId: "U1", slackTeamId: "T1",
      displayName: "Sam Setter", isBot: false, isDeleted: false,
      firstSeenAt: 0, lastSeenAt: 0, lastSyncedAt: 0,
    });

    const alpha = await insertAttributionTeam(ctx, tenantId, "Alpha");
    const beta = await insertAttributionTeam(ctx, tenantId, "Beta");
    const dana = await insertDmCloser(ctx, { tenantId, teamId: alpha, name: "Dana" });
    const fay = await insertDmCloser(ctx, { tenantId, teamId: alpha, name: "Fay" });
    // Linked to a CRM user, so the identity is the user's.
    const eli = await insertDmCloser(ctx, { tenantId, teamId: beta, name: "Eli", userId: admin._id });

    const mapped = (teamId: Id<"attributionTeams">, dmCloserId?: Id<"dmClosers">, medium?: string) => ({
      utmParams: { utm_source: teamId === alpha ? "alpha" : "beta", utm_medium: medium },
      resolution: "mapped" as const,
      teamId,
      dmCloserId,
    });

    async function slackDeal(name: string, bookings: BookingFixture[], index: number) {
      const qualifiedAt = QUALIFIED_AT + index * 60_000;
      const leadId = await ctx.db.insert("leads", {
        ...qualifiedLifecycle(qualifiedAt),
        tenantId,
        fullName: name,
        status: "active",
        firstSeenAt: qualifiedAt,
        updatedAt: qualifiedAt,
      });
      const qualifiedBy = { slackUserId: "U1", slackTeamId: "T1", submittedAt: qualifiedAt };
      const opportunityId = await ctx.db.insert("opportunities", {
        tenantId,
        leadId,
        ...stageFields(bookings.length > 0 ? "scheduled" : "qualified_pending", "slack_qualified"),
        qualifiedBy,
        qualifiedAt,
        assignedCloserId: bookings.length > 0 ? closer!._id : undefined,
        createdAt: qualifiedAt,
        updatedAt: qualifiedAt,
        latestActivityAt: qualifiedAt,
      });
      const meetingIds = [];
      for (const [i, booking] of bookings.entries()) {
        meetingIds.push(
          await insertBooking(ctx, {
            opportunityId,
            closerId: closer!._id,
            key: `${index}-${i}`,
            scheduledAt: FIRST_BOOKING_AT + index * 3_600_000 + i * 86_400_000,
            booking,
          }),
        );
      }
      const eventId = await ctx.db.insert("slackQualificationEvents", {
        tenantId, installationId, leadId, opportunityId,
        resultKind: "created_opportunity", qualifiedBy,
        slackUserId: "U1", slackTeamId: "T1", fullNameSnapshot: name,
        platform: "instagram", handleSnapshot: `lead.${index}`,
        submittedAt: qualifiedAt, createdAt: qualifiedAt,
      });
      await rebuildQualificationRow(ctx, eventId);
      return { opportunityId, meetingIds };
    }

    // A rebook through another DM closer leaves the deal's credit on its first booking (D2).
    await slackDeal("Lead TeamAndDm", [mapped(alpha, dana, "dana"), mapped(alpha, fay, "fay")], 0);
    await slackDeal("Lead TeamOnly", [mapped(alpha)], 1);
    await slackDeal("Lead NoUtms", [{ resolution: "none" }], 2);
    await slackDeal("Lead Unmapped", [{ utmParams: { utm_source: "mystery" }, resolution: "unmapped" }], 3);
    // An internal (ptdom) booking never becomes the deal's first booking.
    await slackDeal(
      "Lead InternalThenExternal",
      [{ utmParams: { utm_source: "ptdom", utm_campaign: "x" }, resolution: "internal" }, mapped(beta, eli, "eli")],
      4,
    );
    await slackDeal("Lead NeverBooked", [], 5);
    // One of the deals whose first booking was never resolved.
    await slackDeal("Lead Unresolved", [{ utmParams: { utm_source: "alpha" } }], 6);

    // A qualification that linked no deal.
    const unlinkedLeadId = await ctx.db.insert("leads", {
      ...qualifiedLifecycle(QUALIFIED_AT),
      tenantId,
      fullName: "Lead Unlinked",
      status: "active",
      firstSeenAt: QUALIFIED_AT,
      updatedAt: QUALIFIED_AT,
    });
    const unlinkedEventId = await ctx.db.insert("slackQualificationEvents", {
      tenantId, installationId, leadId: unlinkedLeadId,
      resultKind: "unlinked",
      qualifiedBy: { slackUserId: "U1", slackTeamId: "T1", submittedAt: QUALIFIED_AT + 7 * 60_000 },
      slackUserId: "U1", slackTeamId: "T1", fullNameSnapshot: "Lead Unlinked",
      platform: "instagram", handleSnapshot: "lead.7",
      submittedAt: QUALIFIED_AT + 7 * 60_000, createdAt: QUALIFIED_AT + 7 * 60_000,
    });
    await rebuildQualificationRow(ctx, unlinkedEventId);

    return { alpha, beta, dana, eli, adminUserId: admin._id };
  });
}

type Credit = {
  fullNameSnapshot: string;
  attributionTeamId?: string;
  dmCloserId?: string;
  attributionResolution: string;
  attributionTeamName?: string;
  dmCloserName?: string;
  dmCloser: { id: string; name: string | null; source: string } | null;
};

function credits(rows: Credit[]) {
  return Object.fromEntries(
    rows.map((row) => [
      row.fullNameSnapshot,
      {
        attributionTeamId: row.attributionTeamId,
        dmCloserId: row.dmCloserId,
        attributionResolution: row.attributionResolution,
        attributionTeamName: row.attributionTeamName,
        dmCloserName: row.dmCloserName,
        dmCloser: row.dmCloser
          ? { id: row.dmCloser.id, name: row.dmCloser.name, source: row.dmCloser.source }
          : null,
      },
    ]),
  );
}

function expectedCredits(ids: Awaited<ReturnType<typeof seed>>) {
  const none = {
    attributionTeamId: undefined,
    dmCloserId: undefined,
    attributionTeamName: undefined,
    dmCloserName: undefined,
    dmCloser: null,
  };
  return {
    "Lead TeamAndDm": {
      attributionTeamId: ids.alpha,
      dmCloserId: ids.dana,
      attributionResolution: "mapped",
      attributionTeamName: "Alpha",
      dmCloserName: "Dana",
      dmCloser: { id: ids.dana, name: "Dana", source: "dm_closer" },
    },
    "Lead TeamOnly": {
      ...none,
      attributionTeamId: ids.alpha,
      attributionTeamName: "Alpha",
      attributionResolution: "mapped",
    },
    "Lead NoUtms": { ...none, attributionResolution: "none" },
    "Lead Unmapped": { ...none, attributionResolution: "unmapped" },
    "Lead InternalThenExternal": {
      attributionTeamId: ids.beta,
      dmCloserId: ids.eli,
      attributionResolution: "mapped",
      attributionTeamName: "Beta",
      dmCloserName: "Eli",
      // A DM closer linked to a user shows as that user.
      dmCloser: { id: ids.adminUserId, name: "admin@example.com", source: "crm_user" },
    },
    "Lead NeverBooked": { ...none, attributionResolution: "none" },
    "Lead Unresolved": { ...none, attributionResolution: "none" },
    "Lead Unlinked": { ...none, attributionResolution: "none" },
  };
}

async function listAll(harness: Harness) {
  const rows: Credit[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page++) {
    const result: { page: Credit[]; isDone: boolean; continueCursor: string } =
      await harness.admin.query(api.operations.qualifications.listQualificationQueue, {
        paginationOpts: { cursor, numItems: 25 },
        ...WINDOW,
      });
    rows.push(...result.page);
    if (result.isDone) return rows;
    cursor = result.continueCursor;
  }
  throw new Error("Queue did not finish paging");
}

async function search(harness: Harness) {
  return await harness.admin.query(api.operations.qualifications.searchQualificationQueue, {
    searchTerm: "lead",
    ...WINDOW,
  });
}

async function scheduling(harness: Harness) {
  const result = await harness.admin.query(api.operations.scheduling.listSchedulingQueue, {
    paginationOpts: { cursor: null, numItems: 50 },
    ...SCHEDULED,
  });
  expect(result.isDone).toBe(true);
  return result.page.map((row) => ({
    ...row,
    fullNameSnapshot: row.leadLabel,
  }));
}

function bookedOnly(expected: ReturnType<typeof expectedCredits>) {
  // The scheduling queue lists deals by their first booking, so it leaves out
  // the deal never booked and the qualification that linked none.
  const rest: Partial<typeof expected> = { ...expected };
  delete rest["Lead NeverBooked"];
  delete rest["Lead Unlinked"];
  return rest;
}

it("labels each qualification with its deal's first booking credit", async () => {
  const harness = await bookingHarness();
  const ids = await seed(harness);
  const expected = expectedCredits(ids);

  const listed = await listAll(harness);
  expect(listed).toHaveLength(8);
  expect(credits(listed)).toEqual(expected);
  expect(credits(await search(harness))).toEqual(expected);
  expect(credits(await scheduling(harness))).toEqual(bookedOnly(expected));
});
