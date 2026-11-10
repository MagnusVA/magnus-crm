import { afterEach, describe, expect, it, vi } from "vitest";
import type { FunctionReturnType } from "convex/server";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  businessDateForInstant,
  DEFAULT_BUSINESS_DAY,
} from "../../lib/businessDay";
import { weekdayForBusinessDate } from "../lib/workSchedule";
import { insertResparkItem } from "../lib/respark/items";
import * as exportsReader from "../leadGen/exports";
import { qualifiedLifecycle } from "../../tests/bookingHarness";
import {
  callTool,
  createMcpHarness,
  mcpConnect,
  seedTenantWithLeadGen,
  testCaller,
} from "../../tests/mcpHarness";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type Floor = FunctionReturnType<typeof internal.mcp.tools.leadGenFloor.floor>;
type Roster = FunctionReturnType<typeof internal.mcp.tools.leadGenFloor.roster>;
type Submissions = FunctionReturnType<
  typeof internal.mcp.tools.leadGenSubmissions.list
>;
type Harness = Awaited<ReturnType<typeof createMcpHarness>>;
type Seed = Awaited<ReturnType<typeof seedTenantWithLeadGen>>;

async function connect(h: Harness, seed: Seed, sub = "user_admin") {
  const token = await h.signToken(sub, { org_id: seed.orgId });
  const { sessionId } = await mcpConnect(h.t, token);
  return { token, sessionId };
}

async function fixture() {
  const h = await createMcpHarness();
  const seed = await seedTenantWithLeadGen(h.t);
  const admin = await connect(h, seed);
  const call = async <T>(name: string, args: Record<string, unknown> = {}) => {
    const result = await callTool(
      h.t,
      admin.token,
      admin.sessionId,
      name,
      args,
    );
    expect(result.response.body?.error, result.text).toBeUndefined();
    expect(result.isError, result.text).toBe(false);
    return result.data as T;
  };
  return { h, seed, admin, call };
}

async function seedCaptures(
  h: Harness,
  seed: Seed,
  count: number,
  options: { nonmatching?: number; longText?: boolean } = {},
) {
  return h.t.run(async (ctx) => {
    const at = Date.now() - 60_000;
    const leadId = await ctx.db.insert("leads", {
      tenantId: seed.tenantId,
      ...qualifiedLifecycle(at),
      status: "active",
      firstSeenAt: at,
      updatedAt: at,
    });
    const prospectId = await ctx.db.insert("leadGenProspects", {
      tenantId: seed.tenantId,
      leadId,
      firstSource: "instagram",
      latestSource: "instagram",
      dedupeKey: "instagram:fixture",
      normalizedHandle: options.longText ? "🐈".repeat(600) : "fixture",
      rawHandle: "fixture",
      profileUrl: "https://instagram.com/fixture",
      firstCapturedByWorkerId: seed.sofiaWorkerId,
      firstCapturedAt: at,
      lastSubmittedByWorkerId: seed.sofiaWorkerId,
      lastSubmittedAt: at,
      latestOriginKind: "reel",
      contactAttemptCount: count,
      distinctWorkerCount: 1,
      createdAt: at,
      updatedAt: at,
    });
    const ids: Id<"leadGenSubmissions">[] = [];
    // Descending order: a match, then a run of filtered-out pages, then the other matches.
    for (let i = 0; i < count + (options.nonmatching ?? 0); i++) {
      const nonmatching =
        i >= count - 1 && i < count - 1 + (options.nonmatching ?? 0);
      const submittedAt = at + i;
      const id = await ctx.db.insert("leadGenSubmissions", {
        tenantId: seed.tenantId,
        workerId: seed.sofiaWorkerId,
        userId: seed.sofiaId,
        teamId: seed.teamId,
        prospectId,
        source: nonmatching ? "meta_business" : "instagram",
        originKind: "reel",
        originValue: options.longText
          ? "🐈".repeat(600)
          : "https://instagram.com/reel/fixture/",
        originRankable: true,
        submittedAt,
        createdAt: submittedAt,
        ...(i === 0
          ? {
              voidedAt: at + 1000,
              voidedByUserId: seed.adminId,
              voidReason: options.longText ? "🐈".repeat(600) : "Wrong capture",
            }
          : {}),
      });
      if (!nonmatching) ids.push(id);
    }
    return { ids, leadId, at };
  });
}

describe("admin lead gen read tools over MCP", () => {
  it("starts the floor from dated schedules, including zero entries, flags, daily stats and respark progress", async () => {
    const { h, seed, call } = await fixture();
    const now = Date.now();
    const today = businessDateForInstant(now, DEFAULT_BUSINESS_DAY);
    const weekday = weekdayForBusinessDate(today);
    const capture = await seedCaptures(h, seed, 2);
    await h.t.run(async (ctx) => {
      await ctx.db.patch("users", seed.adminId, { timezone: "Asia/Tokyo" });
      await ctx.db.patch("leadGenWorkers", seed.daniWorkerId, {
        isActive: false,
        teamId: undefined,
      });
      for (const [workerId, userId] of [
        [seed.sofiaWorkerId, seed.sofiaId],
        [seed.daniWorkerId, seed.daniId],
      ] as const) {
        await ctx.db.insert("leadGenWorkerSchedules", {
          tenantId: seed.tenantId,
          workerId,
          userId,
          weekday,
          scheduledHours: 6,
          effectiveFrom: "2020-01-01",
          updatedByUserId: seed.adminId,
          updatedAt: now,
        });
        await ctx.db.insert("leadGenWorkerSchedules", {
          tenantId: seed.tenantId,
          workerId,
          userId,
          weekday,
          scheduledHours: 12,
          effectiveFrom: "2099-01-01",
          updatedByUserId: seed.adminId,
          updatedAt: now,
        });
      }
      for (const [source, submissions, unique, dupes] of [
        ["instagram", 4, 3, 1],
        ["meta_business", 2, 1, 1],
      ] as const) {
        await ctx.db.insert("leadGenDailyStats", {
          tenantId: seed.tenantId,
          statKey: source,
          dayKey: today,
          workerId: seed.sofiaWorkerId,
          userId: seed.sofiaId,
          teamId: seed.teamId,
          source,
          submissions,
          uniqueProspectsSubmitted: unique,
          duplicateProspectSubmissions: dupes,
          scheduledHours: 999,
          updatedAt: now,
        });
      }
      const batchId = await ctx.db.insert("resparkBatches", {
        tenantId: seed.tenantId,
        userId: seed.sofiaId,
        workerId: seed.sofiaWorkerId,
        teamId: seed.teamId,
        createdAt: now - 1000,
        heldUntil: now + 60_000,
        size: 3,
        requestedSize: 3,
      });
      for (const [position, result] of [
        "resparked",
        "not_a_fit",
        undefined,
      ].entries()) {
        await insertResparkItem(ctx, {
          tenantId: seed.tenantId,
          batchId,
          leadId: capture.leadId,
          userId: seed.sofiaId,
          workerId: seed.sofiaWorkerId,
          position,
          bucket: 1,
          heldUntil: now + 60_000,
          result: result as "resparked" | "not_a_fit" | undefined,
          workedAt: result ? now : undefined,
        });
      }
    });
    const floor = await call<Floor>("magnus_lead_gen_floor");
    expect(floor.timeZone).toBe("Asia/Tokyo");
    expect(floor.asOf).toContain("GMT+9");
    expect(floor.isPartial).toBe(false);
    const sofia = floor.specialists.find(
      (row) => row.workerId === seed.sofiaWorkerId,
    )!;
    expect(sofia).toMatchObject({
      scheduledHours: 6,
      captures: 6,
      unique: 4,
      dupes: 2,
      resparks: 1,
      notAFit: 1,
      flags: [],
      openBatch: { size: 3, worked: 2 },
    });
    expect(sofia.lastCaptureAt).toContain("GMT+9");
    expect(
      floor.specialists.find((row) => row.workerId === seed.daniWorkerId),
    ).toMatchObject({
      scheduledHours: 6,
      captures: 0,
      flags: ["scheduled_no_entries", "no_team", "inactive_with_schedule"],
      lastCaptureAt: null,
    });
    const filtered = await call<Floor>("magnus_lead_gen_floor", {
      teamId: seed.teamId,
    });
    expect(filtered.specialists.map((row) => row.workerId)).toEqual([
      seed.sofiaWorkerId,
    ]);
  });

  it("pages the floor without omissions and refuses a cursor under different filters", async () => {
    const { h, seed, admin, call } = await fixture();
    await h.t.run(async (ctx) => {
      const worker = (await ctx.db.get("leadGenWorkers", seed.sofiaWorkerId))!;
      for (let i = 0; i < 28; i++) {
        await ctx.db.insert("leadGenWorkers", {
          tenantId: seed.tenantId,
          userId: worker.userId,
          workosUserId: `paging_${i}`,
          email: `paging_${i}@example.test`,
          teamId: seed.teamId,
          isActive: true,
          createdAt: 0,
          updatedAt: 0,
        });
      }
    });
    const first = await call<Floor>("magnus_lead_gen_floor");
    expect(first.specialists).toHaveLength(25);
    expect(first.cursor).toBeTruthy();
    const second = await call<Floor>("magnus_lead_gen_floor", {
      cursor: first.cursor,
    });
    expect(second.specialists).toHaveLength(5);
    expect(second.cursor).toBeNull();
    expect(
      new Set(
        [...first.specialists, ...second.specialists].map(
          (row) => row.workerId,
        ),
      ).size,
    ).toBe(30);
    const wrong = await callTool(
      h.t,
      admin.token,
      admin.sessionId,
      "magnus_lead_gen_floor",
      {
        cursor: first.cursor,
        teamId: seed.teamId,
      },
    );
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toContain("cursor");
  });

  it("keeps roster status, team, weekly hours and rules in parity with the web, including inactive rows", async () => {
    const { h, seed, call } = await fixture();
    await h.t.run(async (ctx) => {
      await ctx.db.patch("leadGenWorkers", seed.daniWorkerId, {
        isActive: false,
      });
      await ctx.db.patch("tenants", seed.tenantId, {
        respark: { inactiveAfterDays: 42, batchSize: 12 },
      });
      await ctx.db.insert("leadGenWorkerSchedules", {
        tenantId: seed.tenantId,
        workerId: seed.sofiaWorkerId,
        userId: seed.sofiaId,
        weekday: "monday",
        scheduledHours: 7,
        updatedByUserId: seed.adminId,
        updatedAt: 0,
      });
      await ctx.db.insert("leadGenWorkerSchedules", {
        tenantId: seed.tenantId,
        workerId: seed.sofiaWorkerId,
        userId: seed.sofiaId,
        weekday: "tuesday",
        scheduledHours: 4,
        updatedByUserId: seed.adminId,
        updatedAt: 0,
      });
    });
    const identity = await h.t.run((ctx) => ctx.db.get("users", seed.adminId));
    const web = h.t.withIdentity({
      subject: identity!.workosUserId,
      tokenIdentifier: identity!.workosUserId,
      org_id: seed.orgId,
    });
    for (const includeInactive of [false, true]) {
      const roster = await call<Roster>("magnus_lead_gen_roster", {
        includeInactive,
      });
      const workers = await web.query(api.leadGen.workers.listWorkers, {
        includeInactive,
      });
      const schedules = await web.query(
        api.leadGen.workers.listWorkerSchedules,
        {},
      );
      const rules = await web.query(
        api.respark.settings.getResparkSettings,
        {},
      );
      expect(roster.specialists.map((row) => row.workerId).sort()).toEqual(
        workers.map((row) => row._id).sort(),
      );
      expect(
        roster.specialists.find((row) => row.workerId === seed.sofiaWorkerId)
          ?.weeklyScheduledHours,
      ).toBe(
        schedules
          .filter((row) => row.workerId === seed.sofiaWorkerId)
          .reduce((sum, row) => sum + row.scheduledHours, 0),
      );
      expect(roster.resparkRules).toEqual(rules.settings);
      const teams = await call<Roster>("magnus_lead_gen_roster", {
        includeInactive,
        cursor: roster.cursor,
      });
      expect(teams.cursor).toBeNull();
      expect(
        teams.teams.map((row) => ({
          id: row.teamId,
          name: row.name,
          active: row.active,
        })),
      ).toEqual(
        (
          await web.query(api.leadGen.workers.listTeams, { includeInactive })
        ).map((row) => ({ id: row._id, name: row.name, active: row.isActive })),
      );
    }
  });

  it("accumulates more than two rows, crosses empty filtered pages, carries void metadata and continues without repeats", async () => {
    const { h, seed, call } = await fixture();
    const capture = await seedCaptures(h, seed, 31, { nonmatching: 8 });
    const args = {
      workerId: seed.sofiaWorkerId,
      teamId: seed.teamId,
      source: "instagram",
    };
    const first = await call<Submissions>("magnus_lead_gen_submissions", args);
    expect(first.rows).toHaveLength(25);
    expect(first.isPartial).toBe(true);
    expect(first.cursor).toBeTruthy();
    const second = await call<Submissions>("magnus_lead_gen_submissions", {
      ...args,
      cursor: first.cursor,
    });
    expect(second.rows).toHaveLength(6);
    expect(second.cursor).toBeNull();
    const ids = [...first.rows, ...second.rows].map((row) => row.submissionId);
    expect(ids).toEqual([...capture.ids].reverse());
    expect(new Set(ids).size).toBe(31);
    expect(second.rows.at(-1)).toMatchObject({
      submissionId: capture.ids[0],
      voidedByUserId: seed.adminId,
      voidReason: { text: "Wrong capture", personSupplied: true },
    });
    expect(second.rows.at(-1)?.voidedAt).toBeTruthy();
  });

  it("stops at the total read budget and returns a usable cursor even after empty pages", async () => {
    const { h, seed, call } = await fixture();
    const capture = await seedCaptures(h, seed, 4, { nonmatching: 140 });
    const args = { workerId: seed.sofiaWorkerId, source: "instagram" };
    const first = await call<Submissions>("magnus_lead_gen_submissions", args);
    expect(first.rows.map((row) => row.submissionId)).toEqual([
      capture.ids.at(-1),
    ]);
    expect(first.isPartial).toBe(true);
    expect(first.cursor).toBeTruthy();
    const second = await call<Submissions>("magnus_lead_gen_submissions", {
      ...args,
      cursor: first.cursor,
    });
    expect(second.isPartial).toBe(false);
    expect(
      [...first.rows, ...second.rows].map((row) => row.submissionId),
    ).toEqual([...capture.ids].reverse());
  });

  it("returns no accumulated result when access is revoked between action pages", async () => {
    const { h, seed, admin } = await fixture();
    await seedCaptures(h, seed, 6);
    const original = exportsReader.listRawSubmissionExportPageCore;
    let pages = 0;
    let revocation: Promise<unknown> | undefined;
    const spy = vi
      .spyOn(exportsReader, "listRawSubmissionExportPageCore")
      .mockImplementation(async (ctx, args) => {
        const result = await original(ctx, args);
        if (++pages === 1) {
          // Queue the mutation, then release this query transaction before awaiting it.
          revocation = h.t.run(async (mutation) => {
            await mutation.db.patch("users", seed.adminId, {
              mcpBlockedAt: Date.now(),
            });
          });
        }
        return result;
      });
    const result = await callTool(
      h.t,
      admin.token,
      admin.sessionId,
      "magnus_lead_gen_submissions",
    );
    await revocation;
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("blocked");
    expect(result.data).not.toHaveProperty("rows");
  });

  it("rechecks admin reading after the final page before returning any submissions", async () => {
    const { h, seed, admin } = await fixture();
    await seedCaptures(h, seed, 1);
    const original = exportsReader.listRawSubmissionExportPageCore;
    let revocation: Promise<unknown> | undefined;
    const spy = vi.spyOn(exportsReader, "listRawSubmissionExportPageCore").mockImplementation(async (ctx, args) => {
      const result = await original(ctx, args);
      expect(result.isDone).toBe(true);
      revocation = h.t.run(async (mutation) => {
        const tenant = await mutation.db.get("tenants", seed.tenantId);
        await mutation.db.patch("tenants", seed.tenantId, {
          mcpAccess: { ...tenant!.mcpAccess!, roles: ["closer", "lead_generator", "tenant_master"] },
        });
      });
      return result;
    });
    const result = await callTool(h.t, admin.token, admin.sessionId, "magnus_lead_gen_submissions");
    await revocation;
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("off for your role");
    expect(result.data).not.toHaveProperty("rows");
  });

  it("stops at the wall-clock budget and continues from the last completed page", async () => {
    const { h, seed, call } = await fixture();
    const capture = await seedCaptures(h, seed, 6);
    let clock = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const original = exportsReader.listRawSubmissionExportPageCore;
    let pages = 0;
    vi.spyOn(
      exportsReader,
      "listRawSubmissionExportPageCore",
    ).mockImplementation(async (ctx, args) => {
      const result = await original(ctx, args);
      if (++pages === 1) clock += 3000;
      return result;
    });
    const first = await call<Submissions>("magnus_lead_gen_submissions");
    expect(first.rows).toHaveLength(2);
    expect(first.isPartial).toBe(true);
    const second = await call<Submissions>("magnus_lead_gen_submissions", {
      cursor: first.cursor,
    });
    expect(
      [...first.rows, ...second.rows].map((row) => row.submissionId),
    ).toEqual([...capture.ids].reverse());
    expect(second.isPartial).toBe(false);
  });

  it("refuses lead generators and closers on all three tools", async () => {
    const { h, seed } = await fixture();
    for (const sub of ["user_sofia", "user_alex"]) {
      const session = await connect(h, seed, sub);
      for (const name of [
        "magnus_lead_gen_floor",
        "magnus_lead_gen_roster",
        "magnus_lead_gen_submissions",
      ]) {
        const result = await callTool(
          h.t,
          session.token,
          session.sessionId,
          name,
        );
        expect(result.response.body?.error?.message ?? result.text).toContain(
          "isn't available for your role",
        );
      }
    }
  });

  it.each(["reading off", "blocked"])("refuses every retained admin read with %s at the gateway and inside the tool", async (state) => {
    const { h, seed, admin } = await fixture();
    const owner = h.t.withIdentity({ subject: "user_owner", org_id: seed.orgId });
    if (state === "reading off") {
      await owner.mutation(api.mcp.settings.setRoles, { roles: ["closer", "lead_generator", "tenant_master"] });
    } else {
      await owner.mutation(api.mcp.settings.setUserBlocked, { userId: seed.adminId, blocked: true });
    }
    const message = state === "reading off" ? "off for your role" : "blocked";
    for (const name of ["magnus_lead_gen_floor", "magnus_lead_gen_roster", "magnus_lead_gen_submissions", "magnus_check_handles"]) {
      const result = await callTool(h.t, admin.token, admin.sessionId, name, name === "magnus_check_handles" ? { handles: ["fixture"] } : {});
      expect(result.response.body?.error?.message ?? result.text).toContain(message);
    }
    const caller = testCaller(seed.orgId, "claude-ai", "user_admin");
    await expect(h.t.query(internal.mcp.tools.leadGenFloor.floor, { caller })).rejects.toThrow(message);
    await expect(h.t.query(internal.mcp.tools.leadGenFloor.roster, { caller })).rejects.toThrow(message);
    await expect(h.t.query(internal.mcp.tools.leadGenHandles.check, { caller, handles: ["fixture"] })).rejects.toThrow(message);
    await expect(h.t.action(internal.mcp.tools.leadGenSubmissions.list, { caller })).rejects.toThrow(message);
    await expect(h.t.query(internal.mcp.tools.leadGenSubmissions.readPage, {
      caller, startTimestamp: 0, endTimestamp: Date.now(), cursor: null, numItems: 2,
    })).rejects.toThrow(message);
  });

  it("isolates a second tenant and refuses foreign worker and team filters", async () => {
    const { h, seed } = await fixture();
    await seedCaptures(h, seed, 3);
    const other = await seedTenantWithLeadGen(h.t, { slug: "southwind" });
    const session = await connect(h, other, "southwind_user_admin");
    for (const name of [
      "magnus_lead_gen_floor",
      "magnus_lead_gen_roster",
      "magnus_lead_gen_submissions",
      "magnus_check_handles",
    ]) {
      const result = await callTool(
        h.t,
        session.token,
        session.sessionId,
        name,
        name === "magnus_check_handles" ? { handles: ["fixture"] } : {},
      );
      expect(result.isError, result.text).toBe(false);
      expect(JSON.stringify(result.data)).not.toContain(seed.sofiaWorkerId);
      if (name === "magnus_check_handles") expect(result.data).toMatchObject({ results: [{ verdict: "new", captures: [] }] });
    }
    for (const filters of [
      { workerId: seed.sofiaWorkerId },
      { teamId: seed.teamId },
    ]) {
      const result = await callTool(
        h.t,
        session.token,
        session.sessionId,
        "magnus_lead_gen_submissions",
        filters,
      );
      expect(result.isError).toBe(true);
      expect(result.text).toContain("isn't in this workspace");
    }
  });

  it.each(["🐈", "\u0000"])(
    "trims untrusted %s text, labels it as supplied and bounds a 25-row result to 64 KiB",
    async (character) => {
      const { h, seed, call } = await fixture();
      await seedCaptures(h, seed, 25, { longText: true });
      await h.t.run(async (ctx) => {
        await ctx.db.patch("leadGenWorkers", seed.sofiaWorkerId, {
          displayName: character.repeat(600),
        });
        await ctx.db.patch("attributionTeams", seed.teamId, {
          displayName: character.repeat(600),
        });
      });
      await h.t.run(async (ctx) => {
        const rows = await ctx.db
          .query("leadGenSubmissions")
          .withIndex("by_tenantId_and_submittedAt", (q) =>
            q.eq("tenantId", seed.tenantId),
          )
          .take(25);
        for (const row of rows)
          await ctx.db.patch("leadGenSubmissions", row._id, {
            originValue: character.repeat(600),
          });
      });
      const result = await call<Submissions>("magnus_lead_gen_submissions");
      expect(result.rows).toHaveLength(25);
      expect(
        result.rows.every(
          (row) => row.textTruncated && row.handle?.personSupplied,
        ),
      ).toBe(true);
      expect(
        new TextEncoder().encode(JSON.stringify(result)).length,
      ).toBeLessThan(64 * 1024);
      expect(JSON.stringify(result)).not.toMatch(
        /avatar|profileUrl|thumbnail|preview/i,
      );
    },
  );
});
