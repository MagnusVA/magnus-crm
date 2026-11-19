import { afterEach, describe, expect, it, vi } from "vitest";
import { bookingHarness } from "../../tests/bookingHarness";
import { enrollmentHarness, insertProgram } from "../../tests/enrollmentFixtures";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

const { upsertProgram, setProgramLinkCode, archiveProgram } = api.tenantPrograms.mutations;

describe("program link code mutations", () => {
  it("allocates distinct codes for different names with the same slug", async () => {
    const { t, admin } = await bookingHarness();

    const firstId = await admin.mutation(upsertProgram, { name: "Élite Coaching" });
    const secondId = await admin.mutation(upsertProgram, { name: "Elite Coaching!" });

    const [first, second] = await t.run(async (ctx) => [
      await ctx.db.get("tenantPrograms", firstId),
      await ctx.db.get("tenantPrograms", secondId),
    ]);
    expect(first?.linkCode).toBe("elite-coaching");
    expect(second?.linkCode).toBe("elite-coaching-2");
  });

  it("allocates a code when seeding the initial program", async () => {
    const { t, tenantId } = await bookingHarness();
    const admin = await t.run((ctx) => ctx.db.query("users")
      .withIndex("by_workosUserId", (q) => q.eq("workosUserId", "user_admin")).unique());
    if (!admin) throw new Error("Missing fixture admin");

    const programId = await t.mutation(internal.tenantPrograms.seed.ensureInitialProgramForTenant, {
      tenantId, createdByUserId: admin._id, name: "25K Accelerator",
    });

    expect(await t.run((ctx) => ctx.db.get("tenantPrograms", programId))).toMatchObject({
      linkCode: "25k-accelerator",
    });
  });

  it("reserves current and retired codes and lets their owner reclaim them", async () => {
    const { t, admin } = await bookingHarness();
    const firstId = await admin.mutation(upsertProgram, { name: "Coaching" });
    const secondId = await admin.mutation(upsertProgram, { name: "Mentoring" });
    const change = (programId: Id<"tenantPrograms">, linkCode: string) =>
      admin.mutation(setProgramLinkCode, { programId, linkCode });
    const read = () => t.run((ctx) => ctx.db.get("tenantPrograms", firstId));

    await expect(change(firstId, "  COACHING-VIP ")).resolves.toBe("coaching-vip");
    expect(await read()).toMatchObject({ linkCode: "coaching-vip", retiredLinkCodes: ["coaching"] });

    for (const code of ["coaching-vip", "coaching"]) {
      await expect(change(secondId, code)).rejects.toMatchObject({
        name: "ConvexError",
        data: { code: "program.link_code_taken" },
      });
    }

    await expect(change(firstId, "coaching")).resolves.toBe("coaching");
    expect(await read()).toMatchObject({ linkCode: "coaching", retiredLinkCodes: ["coaching-vip"] });
  });

  it("keeps codes reserved after archiving, including during automatic allocation", async () => {
    const { t, admin } = await bookingHarness();
    const originalId = await admin.mutation(upsertProgram, { name: "Coaching!" });
    await admin.mutation(setProgramLinkCode, { programId: originalId, linkCode: "coaching-vip" });
    await admin.mutation(upsertProgram, { name: "Other" });
    await admin.mutation(archiveProgram, { programId: originalId });

    for (const linkCode of ["coaching", "coaching-vip"]) {
      await expect(admin.mutation(upsertProgram, { name: "New Program", linkCode }))
        .rejects.toMatchObject({ data: { code: "program.link_code_taken" } });
    }
    const id = await admin.mutation(upsertProgram, { name: "Coaching?" });
    expect(await t.run((ctx) => ctx.db.get("tenantPrograms", id))).toMatchObject({
      linkCode: "coaching-2",
    });
  });

  it("normalizes explicit upsert codes and retires the previous code on edit", async () => {
    const { t, admin } = await bookingHarness();
    const name = "Coaching";
    const programId = await admin.mutation(upsertProgram, { name, linkCode: "  START-HERE " });
    const read = () => t.run((ctx) => ctx.db.get("tenantPrograms", programId));
    expect(await read()).toMatchObject({ linkCode: "start-here" });

    await admin.mutation(upsertProgram, { programId, name, description: "New description" });
    expect(await read()).toMatchObject({ linkCode: "start-here" });

    await admin.mutation(upsertProgram, { programId, name, linkCode: " NEXT-STEP " });
    expect(await read()).toMatchObject({ linkCode: "next-step", retiredLinkCodes: ["start-here"] });
  });

  it.each(["", "-coaching", "coaching_vip", "a".repeat(25)])("rejects a malformed code %j", async (linkCode) => {
    const { t, admin } = await bookingHarness();
    const programId = await admin.mutation(upsertProgram, { name: "Coaching" });

    await expect(admin.mutation(setProgramLinkCode, { programId, linkCode }))
      .rejects.toMatchObject({ data: { code: "program.link_code_invalid" } });
    await expect(admin.mutation(upsertProgram, { name: "Other", linkCode }))
      .rejects.toMatchObject({ data: { code: "program.link_code_invalid" } });
    expect(await t.run((ctx) => ctx.db.get("tenantPrograms", programId))).toMatchObject({ linkCode: "coaching" });
  });
});

describe("program link code migrations", () => {
  afterEach(() => vi.useRealTimers());

  it("fills legacy rows, preserves reserved codes, and passes the assertion after a rerun", async () => {
    const h = await enrollmentHarness();
    const current = await h.admin.mutation(upsertProgram, { name: "Coaching!", linkCode: "vip" });
    const legacy = await h.t.run(async (ctx) => {
      await ctx.db.patch("tenantPrograms", current, { retiredLinkCodes: ["coaching"] });
      const first = await insertProgram(ctx, h.tenantId, "Coaching");
      const second = await insertProgram(ctx, h.tenantId, "Coaching?");
      await ctx.db.patch("tenantPrograms", second, { archivedAt: 0 });
      return [first, second];
    });
    const read = () => h.t.run(async (ctx) => {
      const reserved = await ctx.db.get("tenantPrograms", current);
      const codes = await Promise.all(legacy.map(async (id) => (await ctx.db.get("tenantPrograms", id))?.linkCode));
      return { reserved, codes: codes.sort() };
    });

    expect(await h.run("backfillProgramLinkCodes")).toMatchObject({ isDone: true });
    const backfilled = await read();
    expect(backfilled.reserved).toMatchObject({ linkCode: "vip", retiredLinkCodes: ["coaching"] });
    expect(backfilled.codes).toEqual(["coaching-2", "coaching-3"]);
    expect(await h.rerun("backfillProgramLinkCodes")).toMatchObject({ isDone: true });
    expect(await read()).toEqual(backfilled);
    expect(await h.run("assertProgramLinkCodes")).toMatchObject({ isDone: true });
  });

  it("reports a missing code before backfill", async () => {
    const h = await enrollmentHarness();
    const id = await h.t.run((ctx) => insertProgram(ctx, h.tenantId, "Legacy"));

    expect((await h.run("assertProgramLinkCodes"))?.error).toContain(`Program ${id} has no link code`);
  });

  it("reports a current code shared with another program's retired code", async () => {
    const h = await enrollmentHarness();
    const programId = await h.admin.mutation(upsertProgram, { name: "Coaching" });
    const otherId = await h.admin.mutation(upsertProgram, { name: "Mentoring" });
    await h.t.run((ctx) => ctx.db.patch("tenantPrograms", otherId, { retiredLinkCodes: ["coaching"] }));

    const error = (await h.run("assertProgramLinkCodes"))?.error;
    expect(error).toContain("shares a link code with another program");
    expect(error).toMatch(new RegExp(`Program (${programId}|${otherId}) shares`));
  });
});
