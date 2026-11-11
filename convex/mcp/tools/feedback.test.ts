import { afterEach, describe, expect, it, vi } from "vitest";
import { callTool, createMcpHarness, mcpConnect, mcpRpc, seedTenantWithLeadGen, testCaller } from "../../../tests/mcpHarness";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { gateway } from "../gateway";
import { FEEDBACK_DAILY_CAP } from "./feedback";

/** `magnus_send_feedback`, through `/mcp`, for every role with a toolset. */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const TOOL = "magnus_send_feedback";
const SECRET = "Feedback text marker 7f3a";

const REPORT = {
  summary: `Tried to log a payment for a deal. ${SECRET}`,
  outcome: "partly_done",
  worked: "magnus_today listed the meetings.",
  failed: "magnus_log_payment refused the proof upload with a size error.",
  couldNotDo: "Split a payment across two deals.",
  toolsUsed: ["magnus_today"],
  toolsFailed: ["mcp__claude_ai_Magnus__magnus_log_payment"],
};

type Seeded = Awaited<ReturnType<typeof seedTenantWithLeadGen>>;

async function fixture() {
  const h = await createMcpHarness();
  const seeded = await seedTenantWithLeadGen(h.t);
  const connect = async (sub: string, client = "claude-ai") => {
    const token = await h.signToken(sub, { org_id: seeded.orgId });
    const { init, sessionId } = await mcpConnect(h.t, token, client);
    const send = (args: Record<string, unknown>) => callTool(h.t, token, sessionId, TOOL, args);
    const list = async () =>
      (((await mcpRpc(h.t, token, "tools/list", {}, sessionId)).body?.result as { tools?: Array<{ name: string; description?: string; annotations?: Record<string, unknown> }> })
        ?.tools ?? []);
    const instructions = (init.body?.result as { instructions?: string } | undefined)?.instructions ?? "";
    return { token, sessionId, send, list, instructions };
  };
  const rows = () => h.t.run((ctx) => ctx.db.query("mcpFeedback").take(100));
  return { ...h, seeded, connect, rows };
}

/** The refusal text, from either the JSON-RPC error or the tool's error result. */
function refusal(call: Awaited<ReturnType<typeof callTool>>): string {
  return call.response.body?.error?.message ?? (call.isError ? call.text ?? "" : "");
}

function saved(call: Awaited<ReturnType<typeof callTool>>) {
  expect(call.response.body?.error).toBeUndefined();
  expect(call.isError).toBe(false);
  return call.data as { feedbackId: Id<"mcpFeedback">; alreadySaved: boolean; message: string };
}

const ROLES: Array<{ sub: string; userKey: keyof Seeded; role: string }> = [
  { sub: "user_alex", userKey: "closerId", role: "closer" },
  { sub: "user_owner", userKey: "ownerId", role: "tenant_master" },
  { sub: "user_admin", userKey: "adminId", role: "tenant_admin" },
  { sub: "user_sofia", userKey: "sofiaId", role: "lead_generator" },
];

describe("magnus_send_feedback", () => {
  it("is listed, explained and saved for every role, admins with changes off included", async () => {
    const h = await fixture();
    for (const { sub, userKey, role } of ROLES) {
      const me = await h.connect(sub, `client-${role}`);
      const tools = await me.list();
      expect(tools.filter((tool) => tool.name === TOOL)).toHaveLength(1);
      // The schema carries no field descriptions, so the values must be in the text.
      expect(tools.find((tool) => tool.name === TOOL)?.description).toContain("done, partly_done or not_done");
      expect(tools.find((tool) => tool.name === TOOL)?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
      });
      expect(me.instructions).toContain(TOOL);

      const result = saved(await me.send({ ...REPORT, summary: `${REPORT.summary} (${role})` }));
      expect(result.alreadySaved).toBe(false);
      expect(JSON.stringify(result)).not.toContain(SECRET);

      const row = await h.t.run((ctx) => ctx.db.get("mcpFeedback", result.feedbackId));
      expect(row).toMatchObject({
        tenantId: h.seeded.tenantId,
        userId: h.seeded[userKey],
        role,
        agentClient: `client-${role}`,
        summary: `${REPORT.summary} (${role})`,
        outcome: "partly_done",
        worked: REPORT.worked,
        failed: REPORT.failed,
        couldNotDo: REPORT.couldNotDo,
        // A client-prefixed name is stored as the Magnus name, and a failed
        // tool counts as used.
        toolsUsed: ["magnus_log_payment", "magnus_today"],
        toolsFailed: ["magnus_log_payment"],
      });
      expect(row?.createdAt).toBeGreaterThan(Date.now() - 60_000);
    }
    expect(await h.rows()).toHaveLength(4);
  });

  it("doesn't spend the admin write budget", async () => {
    const h = await fixture();
    const admin = await h.connect("user_admin");
    // The write bucket holds 3; four different reports in a row all save.
    for (let i = 0; i < 4; i++) {
      saved(await admin.send({ summary: `Report ${i}`, outcome: "done" }));
    }
    expect(await h.rows()).toHaveLength(4);
  });

  it("refuses bad input with a message the agent can act on, and saves nothing", async () => {
    const h = await fixture();
    const alex = await h.connect("user_alex");
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ summary: "   ", outcome: "done" }, "summary must have between 1 and 2,000 characters"],
      [{ summary: "x".repeat(2_001), outcome: "done" }, "summary must have between 1 and 2,000 characters"],
      [{ summary: "ok", outcome: "done", failed: "y".repeat(4_001) }, "failed must have between 1 and 4,000 characters"],
      [{ summary: "ok", outcome: "success" }, "outcome must be one of done, partly_done, not_done"],
      [{ summary: "ok", outcome: "done", toolsUsed: ["log a payment"] }, "must be a Magnus tool name"],
      [{ summary: "ok", outcome: "done", toolsFailed: Array.from({ length: 31 }, (_, i) => `magnus_t${i}`) }, "at most 30 tools"],
    ];
    for (const [args, message] of cases) {
      expect(refusal(await alex.send(args))).toContain(message);
    }
    // Exactly at the limits is fine.
    saved(await alex.send({ summary: "x".repeat(2_000), outcome: "not_done", failed: "y".repeat(4_000) }));
    expect(await h.rows()).toHaveLength(1);
  });

  it("treats empty optional fields as omitted and finds the Magnus name behind any client prefix", async () => {
    const h = await fixture();
    const alex = await h.connect("user_alex");
    const result = saved(
      await alex.send({
        summary: "Looked up a deal.",
        outcome: "done",
        worked: "",
        failed: null,
        couldNotDo: "   ",
        toolsUsed: [
          "Magnus.magnus_person",
          "magnus/magnus_search_deals",
          "magnus-magnus_tasks()",
          "magnus_today",
          // Claude Code, with the server added as "magnus" or "magnus_crm".
          "mcp__magnus__magnus_get_recording",
          "mcp__magnus_crm__magnus_day_summary",
        ],
        toolsFailed: null,
      }),
    );
    const row = await h.t.run((ctx) => ctx.db.get("mcpFeedback", result.feedbackId));
    expect(row).toMatchObject({
      toolsUsed: [
        "magnus_day_summary",
        "magnus_get_recording",
        "magnus_person",
        "magnus_search_deals",
        "magnus_tasks",
        "magnus_today",
      ],
      toolsFailed: [],
    });
    expect(row?.worked).toBeUndefined();
    expect(row?.failed).toBeUndefined();
    expect(row?.couldNotDo).toBeUndefined();
  });

  it("returns the first report for a retry within 10 minutes and saves a later repeat", async () => {
    const h = await fixture();
    const alex = await h.connect("user_alex");
    const first = saved(await alex.send(REPORT));
    // A retry through another client, with the tool list in another order.
    const again = await h.connect("user_alex", "other-client");
    const retry = saved(await again.send({ ...REPORT, toolsUsed: ["magnus_log_payment", "magnus_today"] }));
    expect(retry).toMatchObject({ feedbackId: first.feedbackId, alreadySaved: true });
    expect(await h.rows()).toHaveLength(1);

    await h.t.run((ctx) => ctx.db.patch("mcpFeedback", first.feedbackId, { createdAt: Date.now() - 11 * 60_000 }));
    const later = saved(await alex.send(REPORT));
    expect(later.alreadySaved).toBe(false);
    expect(later.feedbackId).not.toBe(first.feedbackId);
    expect(await h.rows()).toHaveLength(2);
  });

  it(`caps a user at ${FEEDBACK_DAILY_CAP} reports a day, and a retry still returns the last one`, async () => {
    const h = await fixture();
    const alex = await h.connect("user_alex");
    const now = Date.now();
    await h.t.run(async (ctx) => {
      for (let i = 0; i < FEEDBACK_DAILY_CAP - 1; i++) {
        await ctx.db.insert("mcpFeedback", {
          tenantId: h.seeded.tenantId,
          userId: h.seeded.closerId,
          role: "closer",
          agentClient: "claude-ai",
          summary: `Old ${i}`,
          outcome: "done",
          toolsUsed: [],
          toolsFailed: [],
          contentHash: `seed-${i}`,
          createdAt: now - 60 * 60_000 - i,
        });
      }
    });
    const last = saved(await alex.send(REPORT));
    expect(refusal(await alex.send({ summary: "One more", outcome: "done" }))).toContain(
      `You've sent ${FEEDBACK_DAILY_CAP} feedback reports in the last 24 hours`,
    );
    expect(saved(await alex.send(REPORT))).toMatchObject({ feedbackId: last.feedbackId, alreadySaved: true });
    // Reports older than 24 hours stop counting.
    await h.t.run(async (ctx) => {
      const old = await ctx.db
        .query("mcpFeedback")
        .withIndex("by_tenantId_and_userId_and_createdAt", (q) =>
          q.eq("tenantId", h.seeded.tenantId).eq("userId", h.seeded.closerId).lt("createdAt", now - 30 * 60_000),
        )
        .take(1);
      await ctx.db.patch("mcpFeedback", old[0]._id, { createdAt: now - 25 * 60 * 60_000 });
    });
    saved(await alex.send({ summary: "Now there's room", outcome: "done" }));
    // Another user's cap is their own.
    saved(await (await h.connect("user_sofia")).send({ summary: "Mine", outcome: "done" }));
    expect(await h.rows()).toHaveLength(FEEDBACK_DAILY_CAP + 2);
  });

  it("keeps the text out of the gateway audit log, for saved, refused and malformed calls", async () => {
    const h = await fixture();
    const alex = await h.connect("user_alex");
    saved(await alex.send(REPORT));
    refusal(await alex.send({ summary: SECRET, outcome: "nope" }));
    // Fails the Convex validator, whose error quotes the arguments.
    await alex.send({ summary: SECRET, outcome: "done", toolsUsed: [123], transcript: SECRET });
    const audit = await h.t.run((ctx) => gateway.listAuditEntries(ctx, { toolName: TOOL, limit: 10 }));
    expect(audit.length).toBe(3);
    for (const row of audit) {
      expect(row.args ?? null).toBeNull();
      expect(JSON.stringify(row)).not.toContain(SECRET);
    }
    expect(await h.rows()).toHaveLength(1);
  });

  it("refuses a blocked user and a role that is switched off", async () => {
    const h = await fixture();
    const alex = await h.connect("user_alex");
    await h.t.run((ctx) => ctx.db.patch("users", h.seeded.closerId, { mcpBlockedAt: Date.now() }));
    expect(refusal(await alex.send(REPORT))).not.toBe("");
    await h.t.run((ctx) =>
      ctx.db.patch("tenants", h.seeded.tenantId, {
        mcpAccess: { roles: ["closer"], changedAt: Date.now(), changedByUserId: h.seeded.ownerId },
      }),
    );
    const sofia = await h.connect("user_sofia");
    expect((await sofia.list()).map((tool) => tool.name)).not.toContain(TOOL);
    expect(refusal(await sofia.send(REPORT))).not.toBe("");
    expect(await h.rows()).toHaveLength(0);
  });

  it("checks the caller in the function itself, even for a retry of a saved report", async () => {
    const h = await fixture();
    const send = (caller: ReturnType<typeof testCaller>) =>
      h.t.mutation(internal.mcp.tools.feedback.send, { caller, summary: "Direct", outcome: "done" });
    const first = await send(testCaller(h.seeded.orgId));
    expect(first.alreadySaved).toBe(false);
    // The gateway's authorize refuses a blocked user first; the tool's own
    // guard must refuse too, before it hands back a receipt.
    await h.t.run((ctx) => ctx.db.patch("users", h.seeded.closerId, { mcpBlockedAt: Date.now() }));
    await expect(send(testCaller(h.seeded.orgId))).rejects.toThrow("blocked");
    await expect(send(testCaller("org_other"))).rejects.toThrow("another workspace");
    expect(await h.rows()).toHaveLength(1);
  });

  it("is deleted with its tenant", async () => {
    const h = await fixture();
    saved(await (await h.connect("user_alex")).send(REPORT));
    const other = await h.t.run((ctx) =>
      ctx.db.insert("mcpFeedback", {
        tenantId: h.seeded.tenantId,
        userId: h.seeded.closerId,
        role: "closer",
        agentClient: "claude-ai",
        summary: "kept?",
        outcome: "done",
        toolsUsed: [],
        toolsFailed: [],
        contentHash: "x",
        createdAt: Date.now(),
      }),
    );
    const otherTenant = await seedTenantWithLeadGen(h.t, { orgId: "org_other", slug: "other" });
    const kept = await h.t.run((ctx) =>
      ctx.db.insert("mcpFeedback", {
        tenantId: otherTenant.tenantId,
        userId: otherTenant.closerId,
        role: "closer",
        agentClient: "claude-ai",
        summary: "other tenant",
        outcome: "done",
        toolsUsed: [],
        toolsFailed: [],
        contentHash: "y",
        createdAt: Date.now(),
      }),
    );
    const { deletedCounts } = await h.t.mutation(internal.admin.tenantsMutations.deleteTenantRuntimeDataBatch, {
      tenantId: h.seeded.tenantId,
    });
    expect(deletedCounts.mcpFeedback).toBe(2);
    const left = await h.rows();
    expect(left.map((row) => row._id)).toEqual([kept]);
    expect(left.map((row) => row._id)).not.toContain(other);
  });
});
