import { describe, expect, it } from "vitest";
import { bookingHarness, testLeadGenTeam } from "../../tests/bookingHarness";
import { api, internal } from "../_generated/api";

const { createDmCloser, updateDmCloser } = api.attribution.dmClosers;
const { updateRole, updateRoleAndInvitation } = internal.workos.userMutations;
const INACTIVE_USER_ERROR = {
  data: { code: "attribution.rejected", message: "That CRM user is deactivated. Pick an active user." },
};

async function setup() {
  const { t, tenantId, admin } = await bookingHarness();
  const users = await t.run((ctx) => ctx.db.query("users")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId)).take(10));
  const closer = users.find((user) => user.role === "closer");
  const adminUser = users.find((user) => user.role === "tenant_admin");
  if (!closer || !adminUser) throw new Error("Missing fixture users");

  const closerId = closer._id;
  const teamId = await t.run((ctx) => testLeadGenTeam(ctx, tenantId, "dm-team"));
  const dmCloserFields = { teamId, displayName: "DM Setter", utmMedium: "dm-setter" };
  const deactivate = () => t.run((ctx) => ctx.db.patch("users", closerId, { isActive: false }));
  const readCloser = () => t.run((ctx) => ctx.db.get("users", closerId));
  await t.run((ctx) => ctx.db.patch("users", closerId, {
    personalEventTypeUri: "https://calendly.com/closer/sales",
    closerLinkInPortalAt: 1,
  }));
  return { t, admin, adminId: adminUser._id, closerId, dmCloserFields, deactivate, readCloser };
}

describe("closer portal flag on user changes", () => {
  it("clears the flag when a closer is removed", async () => {
    const h = await setup();
    expect((await h.readCloser())?.closerLinkInPortalAt).toBe(1);

    await h.t.mutation(internal.workos.userMutations.removeUser, { userId: h.closerId });

    const user = await h.readCloser();
    expect(user).toMatchObject({ isActive: false, deletedAt: expect.any(Number) });
    expect(user?.closerLinkInPortalAt).toBeUndefined();
  });

  it.each(["role change", "role and invitation change"] as const)(
    "clears the flag when the closer becomes an admin via %s",
    async (change) => {
      const h = await setup();
      const args = { userId: h.closerId, role: "tenant_admin" as const };

      if (change === "role change") {
        await h.t.mutation(updateRole, args);
      } else {
        await h.t.mutation(updateRoleAndInvitation, { ...args, workosInvitationId: "invitation" });
      }

      const user = await h.readCloser();
      expect(user?.role).toBe("tenant_admin");
      expect(user?.closerLinkInPortalAt).toBeUndefined();
    },
  );
});

describe("DM closer links to inactive CRM users", () => {
  it("rejects a new DM closer linked to an inactive user", async () => {
    const h = await setup();
    await h.deactivate();

    await expect(h.admin.mutation(createDmCloser, { ...h.dmCloserFields, userId: h.closerId }))
      .rejects.toMatchObject(INACTIVE_USER_ERROR);
    expect(await h.t.run((ctx) => ctx.db.query("dmClosers").take(1))).toEqual([]);
  });

  it.each(["omitted", "unchanged"] as const)("allows edits when the inactive user ID is %s", async (mode) => {
    const h = await setup();
    const dmCloserId = await h.admin.mutation(createDmCloser, { ...h.dmCloserFields, userId: h.closerId });
    await h.deactivate();

    await expect(h.admin.mutation(updateDmCloser, {
      ...h.dmCloserFields,
      dmCloserId,
      displayName: "Updated Setter",
      ...(mode === "unchanged" ? { userId: h.closerId } : {}),
    })).resolves.toBe(dmCloserId);

    expect(await h.t.run((ctx) => ctx.db.get("dmClosers", dmCloserId))).toMatchObject({
      displayName: "Updated Setter", userId: h.closerId,
    });
  });

  it("rejects switching the DM closer to an inactive user", async () => {
    const h = await setup();
    const dmCloserId = await h.admin.mutation(createDmCloser, { ...h.dmCloserFields, userId: h.adminId });
    await h.deactivate();

    await expect(h.admin.mutation(updateDmCloser, { ...h.dmCloserFields, dmCloserId, userId: h.closerId }))
      .rejects.toMatchObject(INACTIVE_USER_ERROR);
    expect(await h.t.run((ctx) => ctx.db.get("dmClosers", dmCloserId))).toMatchObject({ userId: h.adminId });
  });
});
