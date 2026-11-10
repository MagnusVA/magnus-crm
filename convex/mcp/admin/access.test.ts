/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { api, internal } from "../../_generated/api";
import { adminCaller, adminFixture } from "../../../tests/mcpAdminFixtures";
import { mcpConnect, mcpRpc, testCaller } from "../../../tests/mcpHarness";

/** Access for admin assistants (docs/plans/admin-assistant.md §4, §5). */
describe("admin assistant access", () => {
  it("lets only the owner switch admin roles on or off", async () => {
    const h = await adminFixture({ read: false });
    await expect(
      h.adminWeb.mutation(api.mcp.settings.setRoles, { roles: ["closer", "tenant_admin"] }),
    ).rejects.toThrow("Only the owner");
    await h.ownerWeb.mutation(api.mcp.settings.setRoles, { roles: ["closer", "tenant_admin"] });
    const tenant = await h.t.run((ctx) => ctx.db.get("tenants", h.tenantId));
    expect(tenant?.mcpAccess?.roles).toEqual(["closer", "tenant_admin"]);
    // An admin may still change the closer switch alone.
    await h.adminWeb.mutation(api.mcp.settings.setRoles, { roles: ["tenant_admin"] });
  });

  it("keeps the write switches when roles change, and clears a role's writes when its reading goes off", async () => {
    const h = await adminFixture({ writeFamilies: ["payments", "opinions"] });
    await h.ownerWeb.mutation(api.mcp.settings.setRoles, { roles: ["tenant_master", "tenant_admin"] });
    let tenant = await h.t.run((ctx) => ctx.db.get("tenants", h.tenantId));
    expect(tenant?.mcpAccess?.writeFamilies).toEqual(["payments", "opinions"]);
    expect(tenant?.mcpAccess?.writeRoles).toEqual(["tenant_master", "tenant_admin"]);
    await h.ownerWeb.mutation(api.mcp.settings.setRoles, { roles: ["tenant_master"] });
    tenant = await h.t.run((ctx) => ctx.db.get("tenants", h.tenantId));
    expect(tenant?.mcpAccess?.writeRoles).toEqual(["tenant_master"]);
  });

  it("refuses a write switch while reading is off, and an admin's own write switch", async () => {
    const h = await adminFixture({ read: false });
    await expect(
      h.ownerWeb.mutation(api.mcp.settings.setWriteAccess, { writeRoles: ["tenant_admin"], writeFamilies: ["payments"] }),
    ).rejects.toThrow("before letting them make changes");
    await h.ownerWeb.mutation(api.mcp.settings.setRoles, { roles: ["closer", "tenant_admin"] });
    await expect(
      h.adminWeb.mutation(api.mcp.settings.setWriteAccess, { writeRoles: ["tenant_admin"], writeFamilies: ["payments"] }),
    ).rejects.toThrow("Only the owner");
    await h.ownerWeb.mutation(api.mcp.settings.setWriteAccess, { writeRoles: ["tenant_admin"], writeFamilies: ["payments"] });
    expect(await h.adminWeb.query(api.mcp.settings.getMyAiAssistantAccess)).toMatchObject({
      roleEnabled: true,
      writeFamilies: ["payments"],
    });
  });

  it("lets an admin neither unblock itself nor block another admin; the owner can, and the time is kept", async () => {
    const h = await adminFixture();
    await h.ownerWeb.mutation(api.mcp.settings.setUserBlocked, { userId: h.adminId, blocked: true });
    await expect(
      h.adminWeb.mutation(api.mcp.settings.setUserBlocked, { userId: h.adminId, blocked: false }),
    ).rejects.toThrow("Only the owner");
    await expect(
      h.adminWeb.mutation(api.mcp.settings.setUserBlocked, { userId: h.ownerId, blocked: true }),
    ).rejects.toThrow("Only the owner");
    // Closers stay an admin's to block.
    await h.adminWeb.mutation(api.mcp.settings.setUserBlocked, { userId: h.closerId, blocked: true });
    await h.ownerWeb.mutation(api.mcp.settings.setUserBlocked, { userId: h.adminId, blocked: false });
    const admin = await h.t.run((ctx) => ctx.db.get("users", h.adminId));
    expect(admin?.mcpBlockedAt).toBeUndefined();
    expect(admin?.mcpBlockChangedAt).toBeGreaterThan(0);
  });

  it("enforces owner-only role changes on the server", async () => {
    const h = await adminFixture();
    await expect(
      h.adminWeb.action(api.workos.userManagement.updateUserRole, { userId: h.closerId, newRole: "tenant_admin" }),
    ).rejects.toThrow("Only the owner");
  });

  it("refuses an admin's MCP calls until the owner switches admins on", async () => {
    const h = await adminFixture({ read: false });
    const list = await mcpRpc(h.t, h.adminToken, "tools/list", {}, h.adminSession);
    const tools = (list.body?.result?.tools as Array<{ name: string }> | undefined) ?? [];
    expect(tools.map((tool) => tool.name)).toEqual([]);
  });

  it("serves admin instructions on initialize", async () => {
    const h = await adminFixture({ writeFamilies: ["payments"] });
    const instructions = (h.adminInit.body?.result as { instructions?: string } | undefined)?.instructions ?? "";
    expect(instructions).toContain("an admin at Northwind Coaching");
    expect(instructions).toContain("magnus_brief");
  });

  it("hides magnus_commit from a closer and from an admin with no changes switched on", async () => {
    const reads = await adminFixture();
    const list = await mcpRpc(reads.t, reads.adminToken, "tools/list", {}, reads.adminSession);
    const names = ((list.body?.result?.tools as Array<{ name: string }>) ?? []).map((tool) => tool.name);
    expect(names).not.toContain("magnus_commit");
    const closer = await mcpConnect(reads.t, reads.closerToken);
    const closerList = await mcpRpc(reads.t, reads.closerToken, "tools/list", {}, closer.sessionId);
    const closerNames = ((closerList.body?.result?.tools as Array<{ name: string }>) ?? []).map((tool) => tool.name);
    expect(closerNames).not.toContain("magnus_commit");
    expect(closerNames).toContain("magnus_today");

    const writes = await adminFixture({ writeFamilies: ["payments"] });
    const writeList = await mcpRpc(writes.t, writes.adminToken, "tools/list", {}, writes.adminSession);
    const writeNames = ((writeList.body?.result?.tools as Array<{ name: string }>) ?? []).map((tool) => tool.name);
    expect(writeNames).toContain("magnus_commit");
  });

  it("refuses a closer's caller in an admin tool's guard", async () => {
    const h = await adminFixture({ writeFamilies: ["payments"] });
    await expect(
      h.t.mutation(internal.mcp.admin.commit.commit, {
        caller: testCaller(h.orgId),
        confirmToken: "ct_x",
        action: "x",
        target: { kind: "payment", id: "x", label: "x" },
        summary: "x",
      }),
    ).rejects.toThrow("isn't available for your role");
    await expect(
      h.t.mutation(internal.mcp.admin.commit.commit, {
        caller: adminCaller(h.orgId),
        confirmToken: "ct_unknown",
        action: "x",
        target: { kind: "payment", id: "x", label: "x" },
        summary: "x",
      }),
    ).rejects.toThrow("isn't valid");
  });
});
