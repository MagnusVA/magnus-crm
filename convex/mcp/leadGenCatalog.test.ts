import { afterEach, describe, expect, it, vi } from "vitest";
import { callTool, createMcpHarness, mcpConnect, mcpRpc, seedTenantWithLeadGen } from "../../tests/mcpHarness";
import { api } from "../_generated/api";
import { resolveLeadGenRange } from "./leadGenShared";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const LEAD_GEN_TOOLS = [
  "magnus_capture_prospects",
  "magnus_check_handles",
  "magnus_claim_respark_batch",
  "magnus_end_lead_gen_shift",
  "magnus_flag_capture",
  "magnus_lead_gen_today",
  "magnus_mark_respark_items",
  "magnus_my_lead_gen_activity",
  "magnus_my_lead_gen_outcomes",
  "magnus_respark_batch",
  "magnus_respark_person",
  "magnus_set_contact_again",
];
const ADMIN_TOOLS = [
  "magnus_assistant_activity",
  "magnus_brief",
  "magnus_check_handles",
  "magnus_end_of_day",
  "magnus_get_recording",
  "magnus_health",
  "magnus_lead_gen_floor",
  "magnus_lead_gen_roster",
  "magnus_lead_gen_submissions",
  "magnus_lookup",
  "magnus_numbers",
  "magnus_queue",
  "magnus_report",
  "magnus_report_list",
  "magnus_setup",
];
const ADMIN_WRITES = [
  "magnus_commit", "magnus_correct_payment", "magnus_cover_closer",
  "magnus_decide_second_opinion", "magnus_next_step", "magnus_record_result",
  "magnus_repair", "magnus_review_payments", "magnus_set_goal",
];

const CLOSER_TOOLS = [
  "magnus_add_call_note", "magnus_attach_proof", "magnus_attach_recording",
  "magnus_day_summary", "magnus_end_day", "magnus_get_recording", "magnus_log_payment",
  "magnus_mark_lost", "magnus_mark_no_show", "magnus_move_callback", "magnus_person",
  "magnus_proof_upload_url", "magnus_search_deals", "magnus_set_callback", "magnus_tasks", "magnus_today",
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

describe("resolveLeadGenRange", () => {
  it("refuses a calendar date that doesn't exist with a message the agent can act on", () => {
    expect(() => resolveLeadGenRange({ startDate: "2026-02-31", endDate: "2026-03-02" }, "2026-03-10")).toThrow(
      "doesn't exist",
    );
    expect(resolveLeadGenRange({ startDate: "2026-02-28", endDate: "2026-03-02" }, "2026-03-10")).toMatchObject({
      days: 3,
      preset: "custom",
    });
  });
});

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
      expect(admin.instructions).toContain(sub === "user_owner" ? "the owner at Northwind Coaching" : "an admin at Northwind Coaching");
      expect(admin.instructions).toContain("magnus_brief");
    }

    // The closer's list is the closer toolset, unchanged by the new roles.
    const alex = await connectAs(h, seeded.orgId, "user_alex");
    expect(alex.names).toEqual(CLOSER_TOOLS);
    expect(alex.names.filter((name) => [...LEAD_GEN_TOOLS, ...ADMIN_TOOLS].includes(name))).toEqual(["magnus_get_recording"]);
    expect(alex.instructions).toContain("Alex Rivera, a closer");
  });

  it("refuses a tool from another role's toolset", async () => {
    const h = await createMcpHarness();
    const seeded = await seedTenantWithLeadGen(h.t);
    const refusal = (call: Awaited<ReturnType<typeof callTool>>) =>
      call.response.body?.error?.message ?? call.text ?? "";

    const sofia = await connectAs(h, seeded.orgId, "user_sofia");
    for (const name of ["magnus_report", "magnus_lead_gen_floor", "magnus_today"]) {
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
    // A role that is off lists nothing, and isn't told it is a closer.
    for (const sub of ["user_sofia", "user_owner"]) {
      const off = await connectAs(h, seeded.orgId, sub);
      expect(off.names).toEqual([]);
      expect(off.instructions).toContain("no tools are listed");
      expect(off.instructions).not.toContain("magnus_today");
    }
    expect((await connectAs(h, seeded.orgId, "user_admin")).names).toEqual(ADMIN_TOOLS);
    expect((await connectAs(h, seeded.orgId, "user_alex")).names).toHaveLength(16);
  });
  it("lists no tools for an admin whose reading was switched off after enabling changes", async () => {
    const h = await createMcpHarness();
    const seed = await seedTenantWithLeadGen(h.t);
    const owner = h.t.withIdentity({ subject: "user_owner", org_id: seed.orgId });
    await owner.mutation(api.mcp.settings.setWriteAccess, { writeRoles: ["tenant_admin"], writeFamilies: ["goals"] });
    await owner.mutation(api.mcp.settings.setRoles, { roles: ["closer", "lead_generator", "tenant_master"] });
    const admin = await connectAs(h, seed.orgId, "user_admin");
    expect(admin.names).toEqual([]);
    expect(admin.instructions).toContain("no tools are listed");
    expect(admin.instructions).not.toContain("magnus_brief");
    expect(admin.instructions).not.toContain("magnus_today");
  });

  it("lists main's write tools alongside the retained reads when the owner enables changes", async () => {
    const h = await createMcpHarness();
    const seed = await seedTenantWithLeadGen(h.t);
    await h.t.withIdentity({ subject: "user_owner", org_id: seed.orgId }).mutation(api.mcp.settings.setWriteAccess, {
      writeRoles: ["tenant_admin", "tenant_master"],
      writeFamilies: ["payments", "results", "opinions", "coverage", "repairs", "goals"],
    });
    for (const sub of ["user_admin", "user_owner"]) {
      const admin = await connectAs(h, seed.orgId, sub);
      expect(admin.names).toEqual([...ADMIN_TOOLS, ...ADMIN_WRITES].sort());
      expect(admin.names).not.toContain("magnus_void_capture");
      expect(admin.names).not.toContain("magnus_lead_gen_report");
    }
  });

  it("lets an admin switch lead generators and block one while preserving the owner's admin switches", async () => {
    const h = await createMcpHarness();
    const seed = await seedTenantWithLeadGen(h.t);
    const admin = h.t.withIdentity({ subject: "user_admin", org_id: seed.orgId });
    await h.t.withIdentity({ subject: "user_owner", org_id: seed.orgId }).mutation(api.mcp.settings.setWriteAccess, {
      writeRoles: ["tenant_master"], writeFamilies: ["goals"],
    });
    const roles = ["closer", "tenant_admin", "tenant_master"] as const;
    await admin.mutation(api.mcp.settings.setRoles, { roles: [...roles] });
    expect((await connectAs(h, seed.orgId, "user_sofia")).names).toEqual([]);
    await admin.mutation(api.mcp.settings.setRoles, { roles: [...roles, "lead_generator"] });
    expect((await connectAs(h, seed.orgId, "user_sofia")).names).toEqual(LEAD_GEN_TOOLS);
    await admin.mutation(api.mcp.settings.setUserBlocked, { userId: seed.sofiaId, blocked: true });
    const blocked = await connectAs(h, seed.orgId, "user_sofia");
    expect(blocked.names).toEqual([]);
    expect(blocked.instructions).toContain("no tools are listed");
    const settings = await admin.query(api.mcp.settings.getAiAssistantSettings, {});
    expect(settings).toMatchObject({ writeRoles: ["tenant_master"], writeFamilies: ["goals"] });
  });

});
