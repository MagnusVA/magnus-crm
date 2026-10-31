import { convexTest } from "convex-test";
import workpool from "@convex-dev/workpool/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import schema from "../../schema";
import { convexTestModules } from "../../test.setup";
import { RATE_LIMIT_PER_MINUTE } from "./keys";

const DAY = 24 * 60 * 60 * 1000;

async function createFixture() {
  const t = convexTest({ schema, modules: convexTestModules });
  workpool.register(t, "analyticsWorkpool");
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const tenant = (org: string) =>
      ctx.db.insert("tenants", {
        businessDayAppliedVersion: 0,
        companyName: org,
        contactEmail: `${org}@example.invalid`,
        workosOrgId: org,
        status: "active",
        inviteExpiresAt: now + DAY,
        createdBy: "test",
        businessDay: { timeZone: "UTC", dayStartHour: 0 },
      });
    const tenantA = await tenant("org_a");
    const tenantB = await tenant("org_b");
    const user = (tenantId: Id<"tenants">, workosUserId: string, role: Doc<"users">["role"]) =>
      ctx.db.insert("users", { tenantId, workosUserId, email: `${workosUserId}@example.invalid`, role, isActive: true, fullName: workosUserId });
    const adminA = await user(tenantA, "admin_a", "tenant_admin");
    await user(tenantA, "closer_a", "closer");
    const adminB = await user(tenantB, "admin_b", "tenant_admin");
    const program = (tenantId: Id<"tenants">, name: string, createdByUserId: Id<"users">) =>
      ctx.db.insert("tenantPrograms", { tenantId, name, normalizedName: name.toLowerCase(), createdAt: now, updatedAt: now, createdByUserId });
    await program(tenantA, "Alpha", adminA);
    await program(tenantB, "Beta", adminB);
    return { tenantA, tenantB, adminA };
  });
  return {
    t,
    ...ids,
    adminA: t.withIdentity({ subject: "admin_a", org_id: "org_a" }),
    closerA: t.withIdentity({ subject: "closer_a", org_id: "org_a" }),
    adminB: t.withIdentity({ subject: "admin_b", org_id: "org_b" }),
  };
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function call(fixture: Fixture, path: string, key?: string) {
  return await fixture.t.fetch(path, {
    method: "GET",
    headers: key ? { Authorization: `Bearer ${key}` } : {},
  });
}

beforeEach(() => {
  // convex/http.ts mounts AuthKit, which reads these at import.
  vi.stubEnv("WORKOS_CLIENT_ID", "client_test");
  vi.stubEnv("WORKOS_API_KEY", "sk_test");
  vi.stubEnv("WORKOS_WEBHOOK_SECRET", "whsec_test");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("API keys", () => {
  it("lets owners and admins create, list and revoke keys, and shows the secret once", async () => {
    const fixture = await createFixture();
    await expect(fixture.closerA.action(api.analytics.api.keys.create, { name: "Dashboard" })).rejects.toThrow(
      "Insufficient permissions",
    );
    await expect(fixture.closerA.query(api.analytics.api.keys.list, {})).rejects.toThrow("Insufficient permissions");

    const created = await fixture.adminA.action(api.analytics.api.keys.create, { name: "Dashboard" });
    expect(created.key).toMatch(/^mgn_live_[0-9A-Za-z]+_[0-9A-Za-z]{43}$/);

    const listed = await fixture.adminA.query(api.analytics.api.keys.list, {});
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(created.key.split("_").at(-1)!);
    const stored = await fixture.t.run(async (ctx) => ctx.db.query("apiKeys").take(10));
    expect(JSON.stringify(stored)).not.toContain(created.key.split("_").at(-1)!);

    await expect(fixture.adminB.mutation(api.analytics.api.keys.revoke, { keyId: created.keyId })).rejects.toThrow(
      "Key not found",
    );
    await fixture.adminA.mutation(api.analytics.api.keys.revoke, { keyId: created.keyId });
    expect((await call(fixture, "/api/v1/freshness", created.key)).status).toBe(401);
  });
});

describe("/api/v1", () => {
  it("rejects a missing, malformed or wrong key", async () => {
    const fixture = await createFixture();
    const { key } = await fixture.adminA.action(api.analytics.api.keys.create, { name: "Dashboard" });
    const wrong = `${key.slice(0, -4)}AAAA`;
    expect((await call(fixture, "/api/v1/freshness")).status).toBe(401);
    expect((await call(fixture, "/api/v1/freshness", "not-a-key")).status).toBe(401);
    expect((await call(fixture, "/api/v1/freshness", wrong)).status).toBe(401);
    expect((await call(fixture, "/api/v1/freshness", key)).status).toBe(200);
  });

  it("answers only the key's tenant", async () => {
    const fixture = await createFixture();
    const { key } = await fixture.adminA.action(api.analytics.api.keys.create, { name: "Dashboard" });
    const response = await call(fixture, "/api/v1/dimensions/programs", key);
    const body = await response.json();
    expect(body.data.map((row: { name: string }) => row.name)).toEqual(["Alpha"]);
  });

  it("allows 60 requests a minute per key", async () => {
    vi.useFakeTimers();
    const fixture = await createFixture();
    const { key } = await fixture.adminA.action(api.analytics.api.keys.create, { name: "Dashboard" });
    for (let index = 0; index < RATE_LIMIT_PER_MINUTE; index += 1) {
      expect((await call(fixture, "/api/v1/freshness", key)).status).toBe(200);
    }
    const limited = await call(fixture, "/api/v1/freshness", key);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    vi.advanceTimersByTime(61_000);
    expect((await call(fixture, "/api/v1/freshness", key)).status).toBe(200);
  });

  it("rejects unknown metrics and groupings a metric doesn't support", async () => {
    const fixture = await createFixture();
    const { key } = await fixture.adminA.action(api.analytics.api.keys.create, { name: "Dashboard" });
    expect((await call(fixture, "/api/v1/metrics?metrics=nope&from=2026-09-01&to=2026-09-30", key)).status).toBe(400);
    expect((await call(fixture, "/api/v1/metrics?metrics=qualifications&group_by=closer&from=2026-09-01&to=2026-09-30", key)).status).toBe(400);
    expect((await call(fixture, "/api/v1/metrics?metrics=calls_held&from=2026-09-01", key)).status).toBe(400);
    expect((await call(fixture, "/api/v1/metrics?metrics=calls_held&from=2026-09-01&to=2026-09-30&tz=Mars/Olympus", key)).status).toBe(400);
    expect((await call(fixture, "/api/v1/today?metrics=calls_held&tz=Mars/Olympus", key)).status).toBe(400);
  });

  it("returns 202 for a new range past the daily budget instead of waking ClickHouse", async () => {
    const fixture = await createFixture();
    vi.stubEnv("CLICKHOUSE_URL", "https://clickhouse.example:8443");
    vi.stubEnv("CLICKHOUSE_USER", "magnus_app");
    vi.stubEnv("CLICKHOUSE_PASSWORD", "secret");
    vi.stubEnv("ANALYTICS_DAILY_RUN_BUDGET", "30");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { key } = await fixture.adminA.action(api.analytics.api.keys.create, { name: "Dashboard" });
    await fixture.t.run(async (ctx) => {
      for (let index = 0; index < 30; index += 1) {
        await ctx.db.insert("analyticsResults", {
          tenantId: fixture.tenantA,
          reportId: "api.metrics",
          argsKey: `other-${index}`,
          filtersJson: "{}",
          range: { kind: "preset", preset: "last_month" },
          timeZone: "UTC",
          dayStartHour: 0,
          status: "ready",
          missedAt: Date.now(),
          lastRequestedAt: Date.now(),
        });
      }
    });
    const response = await call(fixture, "/api/v1/metrics?metrics=calls_held&from=2026-09-01&to=2026-09-30", key);
    expect(response.status).toBe(202);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("API metrics from Convex and from ClickHouse rows", () => {
  it("derive the same rows, rates included", async () => {
    const fixture = await createFixture();
    const day1 = Date.UTC(2026, 8, 1, 15);
    const day2 = Date.UTC(2026, 8, 2, 15);
    const from = Date.UTC(2026, 8, 1);
    const to = Date.UTC(2026, 8, 3);
    const { teamMemberId } = await fixture.t.run(async (ctx) => {
      const closer = (await ctx.db
        .query("users")
        .withIndex("by_workosUserId", (q) => q.eq("workosUserId", "closer_a"))
        .unique())!;
      const teamMemberId = await ctx.db.insert("teamMembers", { tenantId: fixture.tenantA, displayName: "Carla", createdAt: from, updatedAt: from });
      await ctx.db.patch("users", closer._id, { teamMemberId });
      const program = (await ctx.db
        .query("tenantPrograms")
        .withIndex("by_tenantId_and_archivedAt", (q) => q.eq("tenantId", fixture.tenantA))
        .first())!;
      const leadId = await ctx.db.insert("leads", {
        tenantId: fixture.tenantA,
        fullName: "Pat",
        firstSeenAt: from,
        updatedAt: from,
        status: "active",
        lifecycleStage: "customer",
        lifecycleStageEnteredAt: { prospect: from, customer: day1 },
        disposition: "open",
      });
      const dealId = await ctx.db.insert("opportunities", {
        tenantId: fixture.tenantA,
        leadId,
        stage: "closed",
        outcome: "won",
        assignedCloserId: closer._id,
        paymentReceivedAt: day1,
        createdAt: from,
        updatedAt: day1,
      });
      const meeting = (status: Doc<"meetings">["status"], scheduledAt: number, index: number) =>
        ctx.db.insert("meetings", {
          tenantId: fixture.tenantA,
          opportunityId: dealId,
          assignedCloserId: closer._id,
          calendlyEventUri: `event-${index}`,
          calendlyInviteeUri: `invitee-${index}`,
          scheduledAt,
          durationMinutes: 30,
          status,
          createdAt: from - DAY,
        });
      await meeting("held", day1, 1);
      await meeting("no_show", day1, 2);
      await meeting("canceled", day2, 3);
      const payment = (paymentType: Doc<"paymentRecords">["paymentType"], amountMinor: number, recordedAt: number) =>
        ctx.db.insert("paymentRecords", {
          tenantId: fixture.tenantA,
          opportunityId: dealId,
          attributedCloserId: closer._id,
          amountMinor,
          currency: "USD",
          recordedByUserId: closer._id,
          programId: program._id,
          programName: program.name,
          paymentType,
          status: "verified",
          recordedAt,
          origin: "closer_meeting",
        });
      await payment("pif", 100_000, day1);
      await payment("deposit", 20_000, day2);
      return { teamMemberId };
    });

    const metrics = "average_deal_size,calls_held,cancellations,cash_collected,close_rate,deals_won,deposits,no_shows,show_rate";
    const live = JSON.parse(
      await fixture.t.query(internal.analytics.api.queries.liveMetricsForWindow, {
        tenantId: fixture.tenantA,
        metrics,
        granularity: "day",
        groupBy: "closer",
        fromMs: from,
        toMs: to,
        timeZone: "UTC",
        dayStartHour: 0,
      }),
    );
    // What the SQL in api/metrics.ts returns for the same documents.
    const meetingsRow = (period: string, held: number, noShows: number, canceled: number) => ({
      period,
      group_id: teamMemberId,
      calls_scheduled: held + noShows,
      calls_held: held,
      no_shows: noShows,
      cancellations: canceled,
    });
    const rows = {
      meetings_scheduled: [meetingsRow("2026-09-01", 1, 1, 0), meetingsRow("2026-09-02", 0, 0, 1)],
      deals_won: [{ period: "2026-09-01", group_id: teamMemberId, deals_won: 1 }],
      close_rate_cohort: [{ period: "2026-09-01", group_id: teamMemberId, cohort_deals: 1, cohort_won: 1 }],
      payments: [
        { period: "2026-09-01", group_id: teamMemberId, currency: "USD", cash_collected: 100_000, deposits: 0, final_cash: 100_000, final_count: 1 },
        { period: "2026-09-02", group_id: teamMemberId, currency: "USD", cash_collected: 20_000, deposits: 20_000, final_cash: 0, final_count: 0 },
      ],
    };
    const fromRows = JSON.parse(
      await fixture.t.query(internal.analytics.results.previewFinalize, {
        reportId: "api.metrics",
        tenantId: fixture.tenantA,
        filtersJson: JSON.stringify({ metrics, granularity: "day", group_by: "closer" }),
        range: { startDate: "2026-09-01", endDateInclusive: "2026-09-02", fromMs: from, toMs: to, timeZone: "UTC", dayStartHour: 0 },
        rowsJson: JSON.stringify(rows),
      }),
    );

    expect(fromRows).toEqual(live);
    const value = (metric: string, period: string) =>
      live.rows.find((row: { metric: string; period: string }) => row.metric === metric && row.period === period)?.value;
    expect(value("show_rate", "2026-09-01")).toBe(0.5);
    // The won deal's first held call was on 2026-09-01.
    expect(value("close_rate", "2026-09-01")).toBe(1);
    expect(value("close_rate", "2026-09-02")).toBeUndefined();
    expect(value("average_deal_size", "2026-09-01")).toBe(100_000);
    expect(value("average_deal_size", "2026-09-02")).toBeNull();
    expect(value("deposits", "2026-09-02")).toBe(20_000);
  });

  it("count each deal in the close rate once, in the period of its first held call", async () => {
    const fixture = await createFixture();
    const before = Date.UTC(2026, 7, 31, 15);
    const day1 = Date.UTC(2026, 8, 1, 15);
    const day2 = Date.UTC(2026, 8, 2, 15);
    const from = Date.UTC(2026, 8, 1);
    const to = Date.UTC(2026, 8, 3);
    const ids = await fixture.t.run(async (ctx) => {
      const member = (displayName: string) =>
        ctx.db.insert("teamMembers", { tenantId: fixture.tenantA, displayName, createdAt: from, updatedAt: from });
      const carla = await member("Carla");
      const bo = await member("Bo");
      const closerA = (await ctx.db
        .query("users")
        .withIndex("by_workosUserId", (q) => q.eq("workosUserId", "closer_a"))
        .unique())!._id;
      await ctx.db.patch("users", closerA, { teamMemberId: carla });
      const closerB = await ctx.db.insert("users", {
        tenantId: fixture.tenantA, workosUserId: "closer_b", email: "closer_b@example.invalid",
        role: "closer", isActive: true, fullName: "closer_b", teamMemberId: bo,
      });
      const program = (await ctx.db
        .query("tenantPrograms")
        .withIndex("by_tenantId_and_archivedAt", (q) => q.eq("tenantId", fixture.tenantA))
        .first())!;
      const leadId = await ctx.db.insert("leads", {
        tenantId: fixture.tenantA,
        fullName: "Pat",
        firstSeenAt: from,
        updatedAt: from,
        status: "active",
        lifecycleStage: "customer",
        lifecycleStageEnteredAt: { prospect: from, customer: day1 },
        disposition: "open",
      });
      const deal = (outcome: Doc<"opportunities">["outcome"], assignedCloserId: Id<"users">) =>
        ctx.db.insert("opportunities", {
          tenantId: fixture.tenantA,
          leadId,
          stage: outcome === "open" ? "call_held" : "closed",
          outcome,
          assignedCloserId,
          ...(outcome === "won" ? { paymentReceivedAt: day2 } : {}),
          createdAt: from,
          updatedAt: from,
        });
      let index = 0;
      const meeting = async (
        opportunityId: Id<"opportunities">,
        assignedCloserId: Id<"users">,
        scheduledAt: number,
        status: Doc<"meetings">["status"] = "held",
        withProgram = false,
      ) => {
        index += 1;
        await ctx.db.insert("meetings", {
          tenantId: fixture.tenantA,
          opportunityId,
          assignedCloserId,
          calendlyEventUri: `event-${index}`,
          calendlyInviteeUri: `invitee-${index}`,
          scheduledAt,
          durationMinutes: 30,
          status,
          createdAt: from - DAY,
          ...(withProgram ? { bookingProgramId: program._id, bookingProgramName: program.name } : {}),
        });
      };
      // Won: first held with A on day 1 in the program; B's later call doesn't count it again.
      const twoHeld = await deal("won", closerA);
      await meeting(twoHeld, closerA, day1, "held", true);
      await meeting(twoHeld, closerB, day2);
      // Open: first held before the range, so out.
      const heldBefore = await deal("open", closerA);
      await meeting(heldBefore, closerA, before);
      await meeting(heldBefore, closerA, day2);
      // Lost: B on day 2.
      const lost = await deal("lost", closerB);
      await meeting(lost, closerB, day2);
      // Won and now assigned to B, but A held its first call: A's, day 2.
      const reassigned = await deal("won", closerB);
      await meeting(reassigned, closerA, day2, "held", true);
      // Won and paid in the range with no held call: out.
      const paidNoHeld = await deal("won", closerA);
      await meeting(paidNoHeld, closerA, day1, "no_show");
      await ctx.db.insert("paymentRecords", {
        tenantId: fixture.tenantA, opportunityId: paidNoHeld, attributedCloserId: closerA, amountMinor: 100_000,
        currency: "USD", recordedByUserId: closerA, programId: program._id, programName: program.name,
        paymentType: "pif", status: "verified", recordedAt: day1, origin: "closer_meeting",
      });
      // Open: first held with B and no program; A's later call has one. B's, no program.
      const programLater = await deal("open", closerA);
      await meeting(programLater, closerB, day1);
      await meeting(programLater, closerA, day2, "held", true);
      return { carla, bo, programId: program._id };
    });

    const range = { startDate: "2026-09-01", endDateInclusive: "2026-09-02", fromMs: from, toMs: to, timeZone: "UTC", dayStartHour: 0 };
    const compare = async (
      granularity: string,
      groupBy: string,
      cohortRows: Array<{ period: string; group_id: string; cohort_deals: number; cohort_won: number }>,
    ) => {
      const live = JSON.parse(
        await fixture.t.query(internal.analytics.api.queries.liveMetricsForWindow, {
          tenantId: fixture.tenantA, metrics: "close_rate", granularity, groupBy,
          fromMs: from, toMs: to, timeZone: "UTC", dayStartHour: 0,
        }),
      );
      const fromRows = JSON.parse(
        await fixture.t.query(internal.analytics.results.previewFinalize, {
          reportId: "api.metrics",
          tenantId: fixture.tenantA,
          filtersJson: JSON.stringify({ metrics: "close_rate", granularity, group_by: groupBy }),
          range,
          rowsJson: JSON.stringify({ close_rate_cohort: cohortRows }),
        }),
      );
      expect(fromRows).toEqual(live);
      return live.rows.map((row: { period: string; group_id: string | null; value: number | null }) => [row.period, row.group_id, row.value]);
    };

    // What the close_rate_cohort SQL returns for each grouping.
    expect(
      await compare("day", "closer", [
        { period: "2026-09-01", group_id: ids.carla, cohort_deals: 1, cohort_won: 1 },
        { period: "2026-09-01", group_id: ids.bo, cohort_deals: 1, cohort_won: 0 },
        { period: "2026-09-02", group_id: ids.carla, cohort_deals: 1, cohort_won: 1 },
        { period: "2026-09-02", group_id: ids.bo, cohort_deals: 1, cohort_won: 0 },
      ]),
    ).toEqual(
      [
        ["2026-09-01", ids.bo, 0],
        ["2026-09-01", ids.carla, 1],
        ["2026-09-02", ids.bo, 0],
        ["2026-09-02", ids.carla, 1],
      ].sort((left, right) => JSON.stringify([left[0], left[1]]).localeCompare(JSON.stringify([right[0], right[1]]))),
    );
    expect(
      await compare("day", "program", [
        { period: "2026-09-01", group_id: ids.programId, cohort_deals: 1, cohort_won: 1 },
        { period: "2026-09-01", group_id: "", cohort_deals: 1, cohort_won: 0 },
        { period: "2026-09-02", group_id: ids.programId, cohort_deals: 1, cohort_won: 1 },
        { period: "2026-09-02", group_id: "", cohort_deals: 1, cohort_won: 0 },
      ]),
    ).toEqual([
      ["2026-09-01", null, 0],
      ["2026-09-01", ids.programId, 1],
      ["2026-09-02", null, 0],
      ["2026-09-02", ids.programId, 1],
    ]);
    expect(
      await compare("total", "none", [{ period: "total", group_id: "", cohort_deals: 4, cohort_won: 2 }]),
    ).toEqual([["total", null, 0.5]]);
  });
});
