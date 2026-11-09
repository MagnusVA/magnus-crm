import { afterEach, describe, expect, it, vi } from "vitest";
import {
  callTool,
  createMcpHarness,
  mcpConnect,
  mcpRpc,
  seedTenantWithCloser,
} from "../../tests/mcpHarness";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("/mcp", () => {
  it("challenges an anonymous initialize with a 401 that points at the metadata", async () => {
    const { t } = await createMcpHarness();
    const response = await mcpRpc(t, null, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "claude-ai", version: "1" },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate") ?? "").toContain("resource_metadata");
  });

  it("serves protected resource metadata naming AuthKit", async () => {
    const { t } = await createMcpHarness();
    const response = await t.fetch("/.well-known/oauth-protected-resource/mcp", { method: "GET" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.authorization_servers).toEqual(["https://magnus-test.authkit.app"]);
    expect(body.resource).toBe("https://test-deployment.convex.site/mcp");
  });

  it("lists the closer toolset and runs magnus_today for a switched-on closer", async () => {
    const { t, signToken } = await createMcpHarness();
    const seeded = await seedTenantWithCloser(t);
    const token = await signToken("user_alex", { org_id: seeded.orgId });
    const { init, sessionId } = await mcpConnect(t, token);
    expect(init.status).toBe(200);
    const instructions = (init.body?.result as { instructions?: string } | undefined)?.instructions;
    expect(instructions).toContain("Alex Rivera");

    const list = await mcpRpc(t, token, "tools/list", {}, sessionId);
    const names = ((list.body?.result as { tools?: Array<{ name: string }> })?.tools ?? []).map((tool) => tool.name);
    expect(names).toContain("magnus_today");

    const today = await callTool(t, token, sessionId, "magnus_today");
    expect(today.isError).toBe(false);
    expect(today.data).toMatchObject({ closer: "Alex Rivera", timeZone: "America/Tegucigalpa", meetings: [] });
  });

  it("rejects a token for another audience", async () => {
    const { t, signToken } = await createMcpHarness();
    const seeded = await seedTenantWithCloser(t);
    const token = await signToken("user_alex", { org_id: seeded.orgId }, "client_test");
    const { init } = await mcpConnect(t, token);
    expect(init.status).toBe(401);
  });

  it("gives an empty tool list when closers are switched off", async () => {
    const { t, signToken } = await createMcpHarness();
    const seeded = await seedTenantWithCloser(t, { mcpRoles: [] });
    const token = await signToken("user_alex", { org_id: seeded.orgId });
    const { sessionId } = await mcpConnect(t, token);
    const list = await mcpRpc(t, token, "tools/list", {}, sessionId);
    expect((list.body?.result as { tools?: unknown[] })?.tools ?? []).toEqual([]);
    const call = await callTool(t, token, sessionId, "magnus_today");
    expect(call.response.body?.error?.message ?? call.text ?? "").toContain(
      "AI assistant access is off for your role",
    );
  });

  it("refuses a blocked closer and a token from another organization", async () => {
    const { t, signToken } = await createMcpHarness();
    const seeded = await seedTenantWithCloser(t);
    const otherOrg = await signToken("user_alex", { org_id: "org_other" });
    const { sessionId: otherSession } = await mcpConnect(t, otherOrg);
    const list = await mcpRpc(t, otherOrg, "tools/list", {}, otherSession);
    expect((list.body?.result as { tools?: unknown[] })?.tools ?? []).toEqual([]);

    await t.run(async (ctx) => {
      await ctx.db.patch("users", seeded.closerId, { mcpBlockedAt: 1 });
    });
    const token = await signToken("user_alex", { org_id: seeded.orgId });
    const { sessionId } = await mcpConnect(t, token);
    const call = await callTool(t, token, sessionId, "magnus_today");
    expect(call.response.body?.error?.message ?? call.text ?? "").toContain("blocked");
  });
});
