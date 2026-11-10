import { afterEach, describe, expect, it, vi } from "vitest";
import { callTool, createMcpHarness, mcpConnect, mcpRpc, seedTenantWithLeadGen } from "../../tests/mcpHarness";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const LEAD_GEN_TOOLS = [
  "magnus_capture_prospects",
  "magnus_check_handles",
  "magnus_claim_respark_batch",
  "magnus_lead_gen_today",
  "magnus_mark_respark_items",
  "magnus_my_lead_gen_activity",
  "magnus_respark_batch",
  "magnus_respark_person",
];
const ADMIN_TOOLS = [
  "magnus_check_handles",
  "magnus_lead_gen_floor",
  "magnus_lead_gen_report",
  "magnus_lead_gen_roster",
  "magnus_lead_gen_submissions",
  "magnus_void_capture",
];

type Harness = Awaited<ReturnType<typeof createMcpHarness>>;

async function connectAs(h: Harness, orgId: string, sub: string) {
  const token = await h.signToken(sub, { org_id: orgId });
  const { init, sessionId } = await mcpConnect(h.t, token);
  const list = await mcpRpc(h.t, token, "tools/list", {}, sessionId);
  const names = ((list.body?.result as { tools?: Array<{ name: string }> })?.tools ?? [])
    .map((tool) => tool.name)
    .sort();
  const instructions = (init.body?.result as { instructions?: string } | undefined)?.instructions ?? "";
  return { token, sessionId, names, instructions };
}

describe("the one catalog, by role", () => {
  it("lists each role its own toolset and nothing else", async () => {
    const h = await createMcpHarness();
    const seeded = await seedTenantWithLeadGen(h.t);

    const sofia = await connectAs(h, seeded.orgId, "user_sofia");
    expect(sofia.names).toEqual(LEAD_GEN_TOOLS);
    expect(sofia.instructions).toContain("Sofia Mendez, a lead generator");

    for (const sub of ["user_admin", "user_owner"]) {
      const admin = await connectAs(h, seeded.orgId, sub);
      expect(admin.names).toEqual(ADMIN_TOOLS);
      expect(admin.instructions).toContain("an admin at Northwind Coaching");
    }

    // The closer's list is the closer toolset, unchanged by the new roles.
    const alex = await connectAs(h, seeded.orgId, "user_alex");
    expect(alex.names).toContain("magnus_today");
    expect(alex.names).toHaveLength(16);
    expect(alex.names.filter((name) => [...LEAD_GEN_TOOLS, ...ADMIN_TOOLS].includes(name))).toEqual([]);
    expect(alex.instructions).toContain("Alex Rivera, a closer");
  });

  it("refuses a tool from another role's toolset", async () => {
    const h = await createMcpHarness();
    const seeded = await seedTenantWithLeadGen(h.t);
    const refusal = (call: Awaited<ReturnType<typeof callTool>>) =>
      call.response.body?.error?.message ?? call.text ?? "";

    const sofia = await connectAs(h, seeded.orgId, "user_sofia");
    for (const name of ["magnus_lead_gen_report", "magnus_void_capture", "magnus_today"]) {
      expect(refusal(await callTool(h.t, sofia.token, sofia.sessionId, name))).toContain("isn't available for your role");
    }
    const admin = await connectAs(h, seeded.orgId, "user_admin");
    for (const name of ["magnus_capture_prospects", "magnus_claim_respark_batch", "magnus_today"]) {
      expect(refusal(await callTool(h.t, admin.token, admin.sessionId, name))).toContain("isn't available for your role");
    }
    const alex = await connectAs(h, seeded.orgId, "user_alex");
    expect(refusal(await callTool(h.t, alex.token, alex.sessionId, "magnus_lead_gen_today"))).toContain(
      "isn't available for your role",
    );
  });

  it("gives a role nothing while its switch is off, and leaves the others alone", async () => {
    const h = await createMcpHarness();
    const seeded = await seedTenantWithLeadGen(h.t, { mcpRoles: ["closer", "tenant_admin"] });
    expect((await connectAs(h, seeded.orgId, "user_sofia")).names).toEqual([]);
    expect((await connectAs(h, seeded.orgId, "user_owner")).names).toEqual([]);
    expect((await connectAs(h, seeded.orgId, "user_admin")).names).toEqual(ADMIN_TOOLS);
    expect((await connectAs(h, seeded.orgId, "user_alex")).names).toHaveLength(16);
  });
});
