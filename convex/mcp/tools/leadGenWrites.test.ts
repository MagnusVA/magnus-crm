import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { callTool, createMcpHarness, mcpConnect, seedTenantWithLeadGen } from "../../../tests/mcpHarness";

// The lead gen write tools and the handle check, through the real endpoint
// (docs/plans/lead-gen-assistant.md §4): previews that save nothing, list
// commits that save all lines or none, retries that never save twice, and
// the tenant and worker boundaries.

// Fails the Nth daily-stats write, to break a list commit on a late line.
const failure = vi.hoisted(() => ({ failOnCall: 0, calls: 0 }));
vi.mock("../../leadGen/aggregates", async (original) => {
  const actual = await original<typeof import("../../leadGen/aggregates")>();
  return {
    ...actual,
    updateLeadGenDailyStats: async (...args: Parameters<typeof actual.updateLeadGenDailyStats>) => {
      failure.calls += 1;
      if (failure.calls === failure.failOnCall) throw new Error("The day's totals can't be written right now");
      return actual.updateLeadGenDailyStats(...args);
    },
  };
});

afterEach(() => {
  failure.failOnCall = 0;
  failure.calls = 0;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const NOW = Date.parse("2026-10-20T15:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const REEL = "https://www.instagram.com/reel/Cabc123/";

async function fixture() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  const h = await createMcpHarness();
  const seeded = await seedTenantWithLeadGen(h.t);
  const agent = async (sub: string, orgId = seeded.orgId) => {
    const token = await h.signToken(sub, { org_id: orgId });
    const { sessionId } = await mcpConnect(h.t, token);
    return (name: string, args: Record<string, unknown> = {}) => callTool(h.t, token, sessionId, name, args);
  };
  const web = (sub: string) => h.t.withIdentity({ subject: sub, org_id: seeded.orgId });
  const rows = <
    T extends "leadGenSubmissions" | "leadGenProspects" | "leads" | "domainEvents" | "leadGenCorrectionEvents",
  >(
    table: T,
  ) =>
    h.t.run((ctx) => ctx.db.query(table).take(500));
  return { ...h, ...seeded, agent, web, rows };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function webCapture(f: Fixture, sub: string, handle: string, at = NOW) {
  vi.setSystemTime(new Date(at));
  const result = await f.web(sub).mutation(api.leadGen.capture.submit, {
    source: "instagram",
    rawHandleOrProfileUrl: handle,
    originKind: "follower",
  });
  vi.setSystemTime(new Date(NOW));
  return result;
}

const list = (handles: string[], extra: Record<string, unknown> = {}) => ({
  requestKey: "list-1",
  source: "instagram",
  origin: { kind: "reel", value: REEL },
  handles,
  ...extra,
});

type Preview = { preview: string; confirmToken?: string; willSave: number; lines: Array<Record<string, unknown>> };
type Commit = {
  ok: true;
  saved: Array<{ handle: string; submissionId: Id<"leadGenSubmissions">; kind: string }>;
  alreadySaved: Array<{ handle: string }>;
  leftOut: Array<{ handle: string | null }>;
};

describe("magnus_check_handles", () => {
  it("tells a lead gen what Magnus knows, saves nothing, and names nobody", async () => {
    const f = await fixture();
    const maya = await webCapture(f, "user_sofia", "@maya.fit.pt");
    await webCapture(f, "user_dani", "https://instagram.com/coachdre_");
    await f.t.run((ctx) => ctx.db.patch("leads", maya.leadId!, { disposition: "do_not_contact" }));
    const before = (await f.rows("leadGenSubmissions")).length;

    const sofia = await f.agent("user_sofia");
    const check = await sofia("magnus_check_handles", {
      handles: ["@Maya.Fit.PT", "coachdre_", "brand.new.one", "not a handle!", "@coachdre_"],
    });
    expect(check.isError).toBe(false);
    const { results, saved } = check.data as { results: Array<Record<string, unknown>>; saved: boolean };
    expect(saved).toBe(false);
    // The two spellings of one handle are one line.
    expect(results.map((r) => [r.handle, r.verdict, r.capturedBy])).toEqual([
      ["maya.fit.pt", "do_not_contact", "you"],
      ["coachdre_", "captured_before", "a teammate"],
      ["brand.new.one", "new", null],
      [null, "invalid", undefined],
    ]);
    expect(JSON.stringify(results)).not.toContain("Dani");
    expect(results.every((r) => r.captures === undefined)).toBe(true);
    expect((await f.rows("leadGenSubmissions")).length).toBe(before);

    const tooMany = await sofia("magnus_check_handles", { handles: Array.from({ length: 11 }, (_, i) => `h${i}`) });
    expect(tooMany.text ?? "").toContain("1 to 10 handles");
  });

  it("gives an admin the captures, a page at a time for one handle, and keeps tenants apart", async () => {
    const f = await fixture();
    const first = await webCapture(f, "user_sofia", "@maya.fit.pt", NOW - 2 * DAY_MS);
    await webCapture(f, "user_dani", "@maya.fit.pt", NOW - DAY_MS);
    const admin = await f.agent("user_admin");
    const check = await admin("magnus_check_handles", { handles: ["maya.fit.pt"] });
    const data = check.data as {
      results: Array<{ verdict: string; captures: Array<Record<string, unknown>>; capturedBy?: unknown }>;
      capturesCursor: string | null;
    };
    expect(data.results[0]).toMatchObject({ verdict: "captured_before" });
    expect(data.results[0].capturedBy).toBeUndefined();
    expect(data.results[0].captures.map((c) => [c.specialist, c.voided])).toEqual([
      ["Dani Cruz", false],
      ["Sofia Mendez", false],
    ]);
    expect(data.results[0].captures[1].submissionId).toBe(first.submissionId);
    expect(data.capturesCursor).toBeNull();

    const twoWithCursor = await admin("magnus_check_handles", { handles: ["a", "b"], cursor: "x" });
    expect(twoWithCursor.text ?? "").toContain("Pass that handle alone");

    // Another tenant knows nothing about this handle.
    const other = await seedTenantWithLeadGen(f.t, { orgId: "org_two", slug: "two" });
    const otherAdmin = await f.agent("two_user_admin", other.orgId);
    const elsewhere = await otherAdmin("magnus_check_handles", { handles: ["maya.fit.pt"] });
    expect((elsewhere.data as typeof data).results[0]).toMatchObject({ verdict: "new", captures: [] });
  });
});

describe("magnus_capture_prospects", () => {
  it("previews without saving, commits every line, and never saves a list twice", async () => {
    const f = await fixture();
    await webCapture(f, "user_dani", "@coachdre_");
    const blocked = await webCapture(f, "user_dani", "@quiet.one");
    await f.t.run((ctx) => ctx.db.patch("leads", blocked.leadId!, { disposition: "do_not_contact" }));
    const before = (await f.rows("leadGenSubmissions")).length;
    const sofia = await f.agent("user_sofia");
    const args = list(["@maya.fit.pt", "coachdre_", "@quiet.one", "@MAYA.fit.pt", "nope!!"]);

    const preview = await sofia("magnus_capture_prospects", { ...args, confirm: false });
    expect(preview.isError).toBe(false);
    const previewed = preview.data as Preview;
    expect(previewed.willSave).toBe(2);
    expect(previewed.lines.map((l) => [l.handle, l.verdict, l.willSave])).toEqual([
      ["maya.fit.pt", "new", true],
      ["coachdre_", "captured_before", true],
      ["quiet.one", "do_not_contact", false],
      [null, "invalid", false],
    ]);
    expect(previewed.preview).toContain("Save 2 of 4 handles as Sofia Mendez");
    expect(previewed.preview).toContain("counts as a dupe");
    expect(previewed.preview).toContain("hasn't been used as an origin before");
    expect((await f.rows("leadGenSubmissions")).length).toBe(before);

    const changed = await sofia("magnus_capture_prospects", {
      ...list(["@maya.fit.pt", "someone.else"]),
      confirm: true,
      confirmToken: previewed.confirmToken,
    });
    expect(changed.text ?? "").toContain("differ from the preview");
    expect((await f.rows("leadGenSubmissions")).length).toBe(before);

    const commit = await sofia("magnus_capture_prospects", { ...args, confirm: true, confirmToken: previewed.confirmToken });
    expect(commit.isError).toBe(false);
    const committed = commit.data as Commit;
    expect(committed.saved.map((s) => [s.handle, s.kind])).toEqual([
      ["maya.fit.pt", "new"],
      ["coachdre_", "dupe"],
    ]);
    expect(committed.leftOut.map((l) => l.handle)).toEqual(["quiet.one", null]);
    expect((await f.rows("leadGenSubmissions")).length).toBe(before + 2);

    // The capture touch says an agent wrote it, and which client.
    const touches = (await f.rows("domainEvents")).filter(
      (event) => event.eventType === "lead.captured" && (event.metadata ?? "").includes('"via":"mcp"'),
    );
    expect(touches).toHaveLength(2);
    expect(touches[0].metadata).toContain('"agentClient":"claude-ai"');

    // A retry of the commit returns the same result.
    const retry = await sofia("magnus_capture_prospects", { ...args, confirm: true, confirmToken: previewed.confirmToken });
    expect(retry.data).toEqual(commit.data);
    // A second preview of the same list finds every line saved, and offers no token.
    const again = (await sofia("magnus_capture_prospects", { ...args, confirm: false })).data as Preview;
    expect(again.willSave).toBe(0);
    expect(again.confirmToken).toBeUndefined();
    expect((await f.rows("leadGenSubmissions")).length).toBe(before + 2);

    // A deliberate repeat is a new list: it saves, and counts as the web counts it.
    const repeat = list(["@maya.fit.pt"], { requestKey: "list-2" });
    const second = (await sofia("magnus_capture_prospects", { ...repeat, confirm: false })).data as Preview;
    const saved = await sofia("magnus_capture_prospects", { ...repeat, confirm: true, confirmToken: second.confirmToken });
    expect((saved.data as Commit).saved.map((s) => s.kind)).toEqual(["dupe"]);
    expect((await f.rows("leadGenSubmissions")).length).toBe(before + 3);
  });

  it("reports lines a second token already saved, and saves the rest once", async () => {
    const f = await fixture();
    const sofia = await f.agent("user_sofia");
    const args = list(["@one.aa", "@two.bb"]);
    const first = (await sofia("magnus_capture_prospects", { ...args, confirm: false })).data as Preview;
    const second = (await sofia("magnus_capture_prospects", { ...args, confirm: false })).data as Preview;
    await sofia("magnus_capture_prospects", { ...args, confirm: true, confirmToken: first.confirmToken });
    const late = await sofia("magnus_capture_prospects", { ...args, confirm: true, confirmToken: second.confirmToken });
    expect(late.isError).toBe(false);
    expect(late.data as Commit).toMatchObject({ saved: [], alreadySaved: [{ handle: "one.aa" }, { handle: "two.bb" }] });
    expect(await f.rows("leadGenSubmissions")).toHaveLength(2);
  });

  it("saves no line when a later one fails, and leaves the token unused", async () => {
    const f = await fixture();
    const sofia = await f.agent("user_sofia");
    const args = list(["@one.aa", "@two.bb", "@three.cc"]);
    const previewed = (await sofia("magnus_capture_prospects", { ...args, confirm: false })).data as Preview;

    failure.failOnCall = 3;
    const failed = await sofia("magnus_capture_prospects", { ...args, confirm: true, confirmToken: previewed.confirmToken });
    expect(failed.isError).toBe(true);
    expect(failed.text ?? "").toContain("can't be written right now");
    expect(await f.rows("leadGenSubmissions")).toHaveLength(0);
    expect(await f.rows("leadGenProspects")).toHaveLength(0);
    expect(await f.rows("leads")).toHaveLength(0);
    expect(
      (await f.rows("domainEvents")).filter(
        (event) => event.eventType === "lead.captured" || event.eventType === "lead.created",
      ),
    ).toHaveLength(0);
    const scheduled = await f.t.run((ctx) => ctx.db.system.query("_scheduled_functions").take(50));
    expect(scheduled.filter((job) => job.name.includes("postLeadGenSubmission"))).toHaveLength(0);

    // The same token still commits once the write goes through.
    failure.failOnCall = 0;
    const commit = await sofia("magnus_capture_prospects", { ...args, confirm: true, confirmToken: previewed.confirmToken });
    expect((commit.data as Commit).saved).toHaveLength(3);
    expect(await f.rows("leadGenSubmissions")).toHaveLength(3);
  });

  it("refuses a commit when a line changed since the preview, or access was switched off", async () => {
    const f = await fixture();
    const sofia = await f.agent("user_sofia");
    const args = list(["@one.aa", "@two.bb"]);
    const previewed = (await sofia("magnus_capture_prospects", { ...args, confirm: false })).data as Preview;

    // A teammate captures one of them in between.
    await webCapture(f, "user_dani", "@two.bb");
    const stale = await sofia("magnus_capture_prospects", { ...args, confirm: true, confirmToken: previewed.confirmToken });
    expect(stale.text ?? "").toContain("Something changed since the preview");
    expect(await f.rows("leadGenSubmissions")).toHaveLength(1);

    const fresh = (await sofia("magnus_capture_prospects", { ...args, confirm: false })).data as Preview;
    await f.t.run((ctx) =>
      ctx.db.patch("tenants", f.tenantId, { mcpAccess: { roles: ["closer"], changedAt: 1, changedByUserId: f.ownerId } }),
    );
    const off = await sofia("magnus_capture_prospects", { ...args, confirm: true, confirmToken: fresh.confirmToken });
    expect(off.response.body?.error?.message ?? off.text ?? "").toContain("AI assistant access is off");
    expect(await f.rows("leadGenSubmissions")).toHaveLength(1);
  });

  it("never saves a handle two people hold, and keeps one lead gen's token from another", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      for (const name of ["First", "Second"]) {
        const leadId = await ctx.db.insert("leads", {
          tenantId: f.tenantId,
          fullName: name,
          status: "active",
          lifecycleStage: "in_conversation",
          lifecycleStageEnteredAt: { in_conversation: NOW },
          disposition: "open",
          resparkGroup: "out",
          firstSeenAt: NOW,
          updatedAt: NOW,
          searchText: name,
        } as never);
        await ctx.db.insert("leadIdentifiers", {
          tenantId: f.tenantId,
          leadId,
          type: "instagram",
          value: "shared.handle",
          rawValue: "shared.handle",
          source: "manual_entry",
          confidence: "verified",
          createdAt: NOW,
        } as never);
      }
    });
    const sofia = await f.agent("user_sofia");
    const args = list(["@shared.handle", "@fine.one"]);
    const previewed = (await sofia("magnus_capture_prospects", { ...args, confirm: false })).data as Preview;
    expect(previewed.lines.map((l) => [l.verdict, l.willSave])).toEqual([
      ["conflict", false],
      ["new", true],
    ]);

    const dani = await f.agent("user_dani");
    const stolen = await dani("magnus_capture_prospects", { ...args, confirm: true, confirmToken: previewed.confirmToken });
    expect(stolen.text ?? "").toContain("isn't valid");
    const commit = await sofia("magnus_capture_prospects", { ...args, confirm: true, confirmToken: previewed.confirmToken });
    expect((commit.data as Commit).saved.map((s) => s.handle)).toEqual(["fine.one"]);

    // An inactive lead gen can neither preview nor commit.
    await f.t.run((ctx) => ctx.db.patch("leadGenWorkers", f.daniWorkerId, { isActive: false }));
    const inactive = await dani("magnus_capture_prospects", { ...list(["@x.yy"]), confirm: false });
    expect(inactive.text ?? "").toContain("isn't active for you");
  });
});

describe("a handle that changed hands", () => {
  it("is a conflict for the check and the capture, though it was captured before", async () => {
    const f = await fixture();
    await webCapture(f, "user_dani", "@shared.handle");
    // The same handle is later recorded on another person.
    await f.t.run(async (ctx) => {
      const leadId = await ctx.db.insert("leads", {
        tenantId: f.tenantId,
        fullName: "Someone Else",
        status: "active",
        lifecycleStage: "in_conversation",
        lifecycleStageEnteredAt: { in_conversation: NOW },
        disposition: "open",
        resparkGroup: "out",
        firstSeenAt: NOW,
        updatedAt: NOW,
        searchText: "Someone Else",
      } as never);
      await ctx.db.insert("leadIdentifiers", {
        tenantId: f.tenantId,
        leadId,
        type: "instagram",
        value: "shared.handle",
        rawValue: "shared.handle",
        source: "manual_entry",
        confidence: "verified",
        createdAt: NOW,
      } as never);
    });
    const sofia = await f.agent("user_sofia");
    const check = await sofia("magnus_check_handles", { handles: ["@shared.handle"] });
    expect((check.data as { results: Array<{ verdict: string }> }).results[0].verdict).toBe("conflict");
    const preview = await sofia("magnus_capture_prospects", { ...list(["@shared.handle"]), confirm: false });
    expect(preview.data as Preview).toMatchObject({ willSave: 0, lines: [{ verdict: "conflict", willSave: false }] });
    expect((preview.data as Preview).confirmToken).toBeUndefined();
    expect(await f.rows("leadGenSubmissions")).toHaveLength(1);
  });
});

describe("a prospect still pointing at a merged person", () => {
  it("takes its verdict from the survivor", async () => {
    const f = await fixture();
    const captured = await webCapture(f, "user_dani", "@moved.person");
    // The person was merged into one marked do not contact, and the prospect
    // hasn't been repointed yet.
    await f.t.run(async (ctx) => {
      const survivorId = await ctx.db.insert("leads", {
        tenantId: f.tenantId,
        fullName: "Survivor",
        status: "active",
        lifecycleStage: "in_conversation",
        lifecycleStageEnteredAt: { in_conversation: NOW },
        disposition: "do_not_contact",
        resparkGroup: "out",
        firstSeenAt: NOW,
        updatedAt: NOW,
        searchText: "Survivor",
      } as never);
      await ctx.db.patch("leads", captured.leadId!, { status: "merged", mergedIntoLeadId: survivorId });
    });
    const sofia = await f.agent("user_sofia");
    const check = await sofia("magnus_check_handles", { handles: ["@moved.person"] });
    expect((check.data as { results: Array<{ verdict: string }> }).results[0].verdict).toBe("do_not_contact");
    const preview = await sofia("magnus_capture_prospects", { ...list(["@moved.person"]), confirm: false });
    expect(preview.data as Preview).toMatchObject({ willSave: 0, lines: [{ verdict: "do_not_contact", willSave: false }] });
  });
});

describe("handles and post links in the read tools", () => {
  it("come back whole, so the agent can pass them on", async () => {
    const f = await fixture();
    const reel = "https://www.instagram.com/reel/17841400000000000";
    await f.web("user_sofia").mutation(api.leadGen.capture.submit, {
      source: "instagram",
      rawHandleOrProfileUrl: "@user_12345678",
      originKind: "reel",
      originUrlOrLabel: reel,
    });
    const sofia = await f.agent("user_sofia");
    const activity = await sofia("magnus_my_lead_gen_activity", { range: "today" });
    const row = (activity.data as { recent: Array<{ handle: string; originValue: { text: string } }> }).recent[0];
    expect(row.handle).toBe("user_12345678");
    expect(row.originValue.text).toContain("17841400000000000");
    const today = await sofia("magnus_lead_gen_today");
    const lastOrigin = (today.data as { counts: { lastOrigin: { value: { text: string } } } }).counts.lastOrigin;
    expect(lastOrigin.value.text).toContain("17841400000000000");
  });
});

describe("the respark write tools", () => {
  async function withPool(people: number) {
    const f = await fixture();
    for (let index = 0; index < people; index += 1) {
      await webCapture(f, "user_sofia", `@pool.${index}`, NOW - (100 - index) * DAY_MS);
    }
    const sofia = await f.agent("user_sofia");
    const claim = await sofia("magnus_claim_respark_batch");
    const items = await f.t.run((ctx) => ctx.db.query("resparkBatchItems").take(100));
    return { f, sofia, claim, items: items.sort((a, b) => a.position - b.position) };
  }
  type Marked = {
    recorded: Array<{ person: string; result: string }>;
    alreadyRecorded: Array<{ person: string }>;
    notRecorded: Array<{ reason: string }>;
  };

  it("claims a batch once, and says so when there is no team", async () => {
    const { f, sofia, claim, items } = await withPool(3);
    expect(claim.data).toMatchObject({ resumed: false, size: 3, noTeam: false });
    expect((claim.data as { heldUntil: string }).heldUntil).toMatch(/\d/);
    expect(items).toHaveLength(3);
    const again = await sofia("magnus_claim_respark_batch");
    expect(again.data).toMatchObject({ resumed: true, size: 3, batchId: (claim.data as { batchId: string }).batchId });

    await f.t.run((ctx) => ctx.db.patch("leadGenWorkers", f.daniWorkerId, { teamId: undefined }));
    const dani = await f.agent("user_dani");
    expect((await dani("magnus_claim_respark_batch")).data).toMatchObject({ batchId: null, noTeam: true });
  });

  it("previews marks, records them all in one commit, and replays a retry", async () => {
    const { f, sofia, items } = await withPool(3);
    const marks = [
      { itemId: items[0]._id, result: "resparked" },
      { itemId: items[1]._id, result: "not_a_fit" },
      { itemId: items[2]._id, result: "skipped" },
    ];
    const preview = await sofia("magnus_mark_respark_items", { marks, confirm: false });
    const previewed = preview.data as { preview: string; confirmToken: string; willRecord: number };
    expect(previewed.willRecord).toBe(3);
    expect(previewed.preview).toContain("@pool.0: resparked");
    expect(previewed.preview).toContain("only after the message was sent");
    expect((await f.t.run((ctx) => ctx.db.get("resparkBatchItems", items[0]._id)))?.result).toBeUndefined();

    const noToken = await sofia("magnus_mark_respark_items", { marks, confirm: true });
    expect(noToken.text ?? "").toContain("Preview first");

    const commit = await sofia("magnus_mark_respark_items", { marks, confirm: true, confirmToken: previewed.confirmToken });
    expect((commit.data as Marked).recorded.map((r) => r.result)).toEqual(["resparked", "not_a_fit", "skipped"]);
    const after = await f.t.run((ctx) => ctx.db.query("resparkBatchItems").take(100));
    expect(after.sort((a, b) => a.position - b.position).map((item) => item.result)).toEqual([
      "resparked",
      "not_a_fit",
      "skipped",
    ]);
    const resparkTouches = (await f.rows("domainEvents")).filter((event) => event.eventType === "lead.resparked");
    expect(resparkTouches).toHaveLength(1);
    expect(resparkTouches[0].metadata).toContain('"via":"mcp"');

    const retry = await sofia("magnus_mark_respark_items", { marks, confirm: true, confirmToken: previewed.confirmToken });
    expect(retry.data).toEqual(commit.data);
    expect((await f.rows("domainEvents")).filter((event) => event.eventType === "lead.resparked")).toHaveLength(1);
  });

  it("reports a mark already recorded the same way, and refuses a list that changed", async () => {
    const { f, sofia, items } = await withPool(3);
    const marks = [
      { itemId: items[0]._id, result: "resparked" },
      { itemId: items[1]._id, result: "resparked" },
    ];
    // Two agents preview the same marks; the first commit wins.
    const first = (await sofia("magnus_mark_respark_items", { marks, confirm: false })).data as { confirmToken: string };
    const second = (await sofia("magnus_mark_respark_items", { marks, confirm: false })).data as { confirmToken: string };
    await sofia("magnus_mark_respark_items", { marks, confirm: true, confirmToken: first.confirmToken });
    const late = await sofia("magnus_mark_respark_items", { marks, confirm: true, confirmToken: second.confirmToken });
    expect(late.data as Marked).toMatchObject({ recorded: [], alreadyRecorded: [{ person: "@pool.0" }, { person: "@pool.1" }] });
    expect((await f.rows("domainEvents")).filter((event) => event.eventType === "lead.resparked")).toHaveLength(2);

    // The web skips the third person after its preview: the whole list is refused.
    const third = [{ itemId: items[2]._id, result: "not_a_fit" }];
    const stale = (await sofia("magnus_mark_respark_items", { marks: third, confirm: false })).data as { confirmToken: string };
    await f.web("user_sofia").mutation(api.respark.batches.skipResparkItem, { itemId: items[2]._id });
    const refused = await sofia("magnus_mark_respark_items", { marks: third, confirm: true, confirmToken: stale.confirmToken });
    expect(refused.text ?? "").toContain("Something changed since the preview");
    expect((await f.t.run((ctx) => ctx.db.get("resparkBatchItems", items[2]._id)))?.result).toBe("skipped");
    const again = (await sofia("magnus_mark_respark_items", { marks: third, confirm: false })).data as {
      willRecord: number;
      confirmToken?: string;
      preview: string;
    };
    expect(again.willRecord).toBe(0);
    expect(again.confirmToken).toBeUndefined();
    expect(again.preview).toContain("can't be changed");
  });

  it("keeps a batch to the lead gen who holds it", async () => {
    const { f, items } = await withPool(2);
    const marks = [{ itemId: items[0]._id, result: "resparked" }];
    const dani = await f.agent("user_dani");
    const theirs = await dani("magnus_mark_respark_items", { marks, confirm: false });
    expect(theirs.text ?? "").toContain("isn't in your batch");
    const admin = await f.agent("user_admin");
    const refused = await admin("magnus_mark_respark_items", { marks, confirm: false });
    expect(refused.response.body?.error?.message ?? refused.text ?? "").toContain("isn't available for your role");
  });
});

describe("magnus_void_capture", () => {
  it("previews, voids once with the token, and gives a voided capture no token", async () => {
    const f = await fixture();
    const captured = await webCapture(f, "user_sofia", "@maya.fit.pt");
    const admin = await f.agent("user_admin");
    const args = { submissionId: captured.submissionId, reason: "  Wrong person  " };

    const preview = await admin("magnus_void_capture", { ...args, confirm: false });
    const previewed = preview.data as { preview: string; confirmToken: string };
    expect(previewed.preview).toContain("Void Sofia Mendez's capture of @maya.fit.pt");
    expect(previewed.preview).toContain("can't be undone");
    expect((await f.rows("leadGenSubmissions"))[0].voidedAt).toBeUndefined();

    const other = await admin("magnus_void_capture", { ...args, reason: "Another reason", confirm: true, confirmToken: previewed.confirmToken });
    expect(other.text ?? "").toContain("differ from the preview");

    const commit = await admin("magnus_void_capture", { ...args, confirm: true, confirmToken: previewed.confirmToken });
    expect(commit.data).toMatchObject({ ok: true, alreadyVoided: false });
    const [voided] = await f.rows("leadGenSubmissions");
    expect(voided).toMatchObject({ voidReason: "Wrong person", voidedByUserId: f.adminId });
    expect(await f.rows("leadGenCorrectionEvents")).toHaveLength(1);

    const retry = await admin("magnus_void_capture", { ...args, confirm: true, confirmToken: previewed.confirmToken });
    expect(retry.data).toEqual(commit.data);
    expect(await f.rows("leadGenCorrectionEvents")).toHaveLength(1);

    const again = await admin("magnus_void_capture", { ...args, confirm: false });
    expect(again.data).toMatchObject({ alreadyVoided: true });
    expect((again.data as { confirmToken?: string }).confirmToken).toBeUndefined();
  });

  it("is an admin's tool, inside one tenant", async () => {
    const f = await fixture();
    const captured = await webCapture(f, "user_sofia", "@maya.fit.pt");
    const args = { submissionId: captured.submissionId, reason: "Wrong person", confirm: false };
    const sofia = await f.agent("user_sofia");
    const refused = await sofia("magnus_void_capture", args);
    expect(refused.response.body?.error?.message ?? refused.text ?? "").toContain("isn't available for your role");

    const other = await seedTenantWithLeadGen(f.t, { orgId: "org_two", slug: "two" });
    const otherAdmin = await f.agent("two_user_admin", other.orgId);
    const elsewhere = await otherAdmin("magnus_void_capture", args);
    expect(elsewhere.text ?? "").toContain("isn't in this workspace");
    expect((await f.rows("leadGenSubmissions"))[0].voidedAt).toBeUndefined();
  });
});
