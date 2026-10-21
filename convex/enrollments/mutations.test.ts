/**
 * An admin changes an enrollment's status (docs/plans/phase-4-customers.md
 * §4.4): a no-op when unchanged or stale, an optional reason for Paused and
 * Churned, an `enrollment.status_changed` event, and the person-level status
 * on the search row.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { bookingHarness } from "../../tests/bookingHarness";
import { seedEnrolledCustomer } from "../../tests/enrollmentPageFixtures";

afterEach(() => vi.useRealTimers());

const NOW = Date.parse("2026-10-10T12:00:00Z");

async function setup(options: { secondProgram?: boolean } = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  const h = await bookingHarness();
  const seeded = await h.t.run((ctx) => seedEnrolledCustomer(ctx, h.tenantId, options));
  return { h, seeded };
}

async function statusEvents(h: Awaited<ReturnType<typeof bookingHarness>>, enrollmentId: Id<"enrollments">) {
  return await h.t.run(async (ctx) =>
    (await ctx.db
      .query("domainEvents")
      .withIndex("by_tenantId_and_entityType_and_entityId_and_occurredAt", (q) =>
        q.eq("tenantId", h.tenantId).eq("entityType", "enrollment").eq("entityId", enrollmentId),
      )
      .take(10)
    ).filter((event) => event.eventType === "enrollment.status_changed"),
  );
}

describe("updateEnrollmentStatus", () => {
  it("refuses a closer, who has no customer:edit", async () => {
    const { h, seeded } = await setup();

    await expect(
      h.closer.mutation(api.enrollments.mutations.updateEnrollmentStatus, {
        enrollmentId: seeded.enrollmentA,
        status: "paused",
        expectedStatus: "active",
      }),
    ).rejects.toThrow("auth.insufficient_permissions");

    const enrollment = await h.t.run((ctx) => ctx.db.get("enrollments", seeded.enrollmentA));
    expect(enrollment?.status).toBe("active");
  });

  it("can't reach another tenant's enrollment", async () => {
    const { h, seeded } = await setup();
    const otherAdmin = h.t.withIdentity({ subject: "user_other_admin", org_id: "org_other" });
    await h.t.run(async (ctx) => {
      const otherTenantId = await ctx.db.insert("tenants", {
        companyName: "Other",
        contactEmail: "other@example.com",
        workosOrgId: "org_other",
        status: "active",
        inviteExpiresAt: 0,
        createdBy: "test",
      });
      await ctx.db.insert("users", {
        tenantId: otherTenantId,
        workosUserId: "user_other_admin",
        email: "other-admin@example.com",
        role: "tenant_admin",
        isActive: true,
      });
    });

    await expect(
      otherAdmin.mutation(api.enrollments.mutations.updateEnrollmentStatus, {
        enrollmentId: seeded.enrollmentA,
        status: "churned",
        expectedStatus: "active",
      }),
    ).rejects.toThrow("enrollment.not_found");

    const enrollment = await h.t.run((ctx) => ctx.db.get("enrollments", seeded.enrollmentA));
    expect(enrollment?.status).toBe("active");
    expect(await statusEvents(h, seeded.enrollmentA)).toHaveLength(0);
  });

  it("changes nothing for the current status or a stale page", async () => {
    const { h, seeded } = await setup();
    const update = (args: { status: "active" | "paused" | "churned"; expectedStatus: "active" | "paused" | "churned" }) =>
      h.admin.mutation(api.enrollments.mutations.updateEnrollmentStatus, {
        enrollmentId: seeded.enrollmentA,
        ...args,
      });

    const unchanged = await update({ status: "active", expectedStatus: "active" });
    // The page loaded while it was paused; it is active now. Picking the
    // status it already has is unchanged, not stale.
    const alreadyThere = await update({ status: "active", expectedStatus: "paused" });
    const stale = await update({ status: "churned", expectedStatus: "paused" });

    expect(unchanged).toBe("unchanged");
    expect(alreadyThere).toBe("unchanged");
    expect(stale).toBe("stale");
    const enrollment = await h.t.run((ctx) => ctx.db.get("enrollments", seeded.enrollmentA));
    expect(enrollment).toMatchObject({ status: "active" });
    expect(enrollment?.statusChangedAt).toBeUndefined();
    expect(enrollment?.statusChangedByUserId).toBeUndefined();
    expect(await statusEvents(h, seeded.enrollmentA)).toHaveLength(0);
  });

  it("requires the status the page showed", async () => {
    const { h, seeded } = await setup();

    await expect(
      h.admin.mutation(api.enrollments.mutations.updateEnrollmentStatus, {
        enrollmentId: seeded.enrollmentA,
        status: "paused",
      } as never),
    ).rejects.toThrow(/expectedStatus/);

    const enrollment = await h.t.run((ctx) => ctx.db.get("enrollments", seeded.enrollmentA));
    expect(enrollment?.status).toBe("active");
  });

  it("takes a trimmed reason of up to 500 characters for Paused and Churned, and none for Active", async () => {
    const { h, seeded } = await setup();
    const update = (args: {
      status: "active" | "paused" | "churned";
      expectedStatus: "active" | "paused" | "churned";
      reason?: string;
    }) =>
      h.admin.mutation(api.enrollments.mutations.updateEnrollmentStatus, {
        enrollmentId: seeded.enrollmentA,
        ...args,
      });

    await expect(
      update({ status: "paused", expectedStatus: "active", reason: "x".repeat(501) }),
    ).rejects.toThrow("enrollment.reason_too_long");
    await expect(
      update({ status: "active", expectedStatus: "active", reason: "Back" }),
    ).rejects.toThrow("enrollment.reason_not_allowed");
    expect(
      await update({ status: "paused", expectedStatus: "active", reason: `  ${"y".repeat(500)}  ` }),
    ).toBe("changed");
    // A blank reason is no reason.
    expect(await update({ status: "churned", expectedStatus: "paused", reason: "   " })).toBe("changed");

    const events = await statusEvents(h, seeded.enrollmentA);
    expect(events.map((event) => event.reason)).toEqual(["y".repeat(500), undefined]);
  });

  it("records who changed it and when, and emits the event, which isn't a touch", async () => {
    const { h, seeded } = await setup();
    const touchesBefore = await h.t.run(async (ctx) => {
      const lead = await ctx.db.get("leads", seeded.leadId);
      return { firstTouch: lead?.firstTouch, latestTouch: lead?.latestTouch };
    });

    const outcome = await h.admin.mutation(api.enrollments.mutations.updateEnrollmentStatus, {
      enrollmentId: seeded.enrollmentA,
      status: "paused",
      reason: " Moving abroad for three months ",
      expectedStatus: "active",
    });

    expect(outcome).toBe("changed");
    const enrollment = await h.t.run((ctx) => ctx.db.get("enrollments", seeded.enrollmentA));
    expect(enrollment).toMatchObject({
      status: "paused",
      statusChangedAt: NOW,
      statusChangedByUserId: seeded.adminId,
    });
    const [event, ...others] = await statusEvents(h, seeded.enrollmentA);
    expect(others).toHaveLength(0);
    expect(event).toMatchObject({
      tenantId: h.tenantId,
      entityType: "enrollment",
      entityId: seeded.enrollmentA,
      eventType: "enrollment.status_changed",
      source: "admin",
      actorUserId: seeded.adminId,
      fromStatus: "active",
      toStatus: "paused",
      reason: "Moving abroad for three months",
      occurredAt: NOW,
      leadId: seeded.leadId,
    });
    expect(JSON.parse(event.metadata!)).toEqual({
      leadId: seeded.leadId,
      programId: seeded.programA,
      opportunityId: seeded.dealA,
    });
    const touchesAfter = await h.t.run(async (ctx) => {
      const lead = await ctx.db.get("leads", seeded.leadId);
      return { firstTouch: lead?.firstTouch, latestTouch: lead?.latestTouch };
    });
    expect(touchesAfter).toEqual(touchesBefore);
  });

  it("rebuilds the search row with the person-level status", async () => {
    const { h, seeded } = await setup({ secondProgram: true });
    type Status = "active" | "paused" | "churned";
    const update = (enrollmentId: Id<"enrollments">, status: Status, expectedStatus: Status) =>
      h.admin.mutation(api.enrollments.mutations.updateEnrollmentStatus, { enrollmentId, status, expectedStatus });
    const read = () =>
      h.t.run(async (ctx) => ({
        row: await ctx.db
          .query("leadCustomerSearchRows")
          .withIndex("by_tenantId_and_leadId", (q) =>
            q.eq("tenantId", h.tenantId).eq("leadId", seeded.leadId),
          )
          .unique(),
      }));

    await update(seeded.enrollmentA, "paused", "active");
    let state = await read();
    // Program B is still active, so the person is (§4.4).
    expect(state.row?.customerStatus).toBe("active");

    await update(seeded.second!.enrollmentId, "churned", "active");
    state = await read();
    expect(state.row?.customerStatus).toBe("paused");

    vi.setSystemTime(new Date(NOW + 1_000));
    await update(seeded.enrollmentA, "churned", "paused");
    state = await read();
    expect(state.row?.customerStatus).toBe("churned");
  });
});
