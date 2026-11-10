import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { api, internal } from "../../_generated/api";
import { adminCaller, adminFixture, seedAdminTenant } from "../../../tests/mcpAdminFixtures";
import { qualifiedLifecycle } from "../../../tests/bookingHarness";
import { callsReportFixture, DAY, from, identity, now, to } from "../../../tests/callsReportFixtures";
import { gatewayAnswerBytes, MAX_ASSISTANT_ANSWER_BYTES } from "../../../lib/assistantReportMerge";
import { OPEN_PIPELINE_STAGES } from "../../reporting/pipelineHealth";
import { pipelineNextStep } from "../../reports/lib/pipelineNextStep";
import { adminReportListTools } from "../toolsets/adminReportLists";

const run = internal.mcp.reports.lists.run;
type Args = Omit<FunctionArgs<typeof run>, "caller">;
type Answer = FunctionReturnType<typeof run>;
type Fixture = Awaited<ReturnType<typeof callsFixture>>;
const range = { kind: "custom" as const, startDate: "2026-09-01", endDateInclusive: "2026-09-04" };
const lists = ["pipeline_open_deals", "pipeline_owed_calls", "log", "member_log", "deal_credits", "report_fields"] as const;

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function callsFixture() {
  vi.stubEnv("WORKOS_CLIENT_ID", "client_test");
  const f = await callsReportFixture();
  await f.t.run(async ctx => {
    await ctx.db.patch("tenants", f.tenantId, { mcpAccess: {
      roles: ["tenant_admin", "closer"], changedAt: 0, changedByUserId: f.admin,
    } });
  });
  return { ...f, caller: adminCaller(identity.org_id, "claude-ai", identity.subject), web: f.t.withIdentity(identity) };
}
async function allTool(f: Pick<Fixture, "t" | "caller">, args: Args) {
  const pages: Answer[] = [];
  let cursor: string | undefined;
  for (let index = 0; index < 200; index++) {
    const page = await f.t.query(run, { caller: f.caller, ...args, ...(cursor ? { cursor } : {}) });
    expect(gatewayAnswerBytes(page)).toBeLessThanOrEqual(MAX_ASSISTANT_ANSWER_BYTES);
    expect(page.rows.length).toBeLessThanOrEqual(args.limit ?? 10);
    pages.push(page);
    if (!page.cursor) return { pages, rows: pages.flatMap(p => p.rows) };
    expect(page.isPartial).toBe(true);
    expect(page.cursor).not.toBe(cursor);
    cursor = page.cursor;
  }
  throw new Error("Tool did not finish paging");
}
async function allPublic<T>(read: (cursor: string | null) => Promise<{ page: T[]; isDone: boolean; continueCursor: string }>) {
  const rows: T[] = [];
  let cursor: string | null = null;
  for (let index = 0; index < 200; index++) {
    const page = await read(cursor);
    rows.push(...page.page);
    if (page.isDone) return rows;
    cursor = page.continueCursor;
  }
  throw new Error("Public query did not finish paging");
}
function untrusted(value: string, by = "person") { return { text: value, by }; }

async function seedLog(f: Fixture) {
  await f.t.run(async ctx => {
    for (let index = 0; index < 60; index++) await ctx.db.insert("domainEvents", {
      tenantId: f.tenantId, entityType: index % 2 ? "meeting" : "payment", entityId: String(f.owed),
      eventType: index % 2 ? "meeting.no_show" : "payment.recorded", occurredAt: from + index,
      actorUserId: index % 2 ? f.ana : f.beto, teamMemberId: index % 2 ? f.memberA : f.memberB,
      source: index % 2 ? "closer" : "admin", toStatus: "held", fromStatus: "scheduled",
      reason: "Private note", metadata: JSON.stringify({ email: "secret@example.com", phone: "+15555551234", receiptUrl: "https://private.test/receipt", referenceCode: "secret-reference" }),
    });
    // The member page includes old events missing teamMemberId, plus events
    // tagged to the member that the system or another member recorded.
    for (const fields of [
      { actorUserId: f.ana },
      { teamMemberId: f.memberA },
      { actorUserId: f.beto, teamMemberId: f.memberA },
    ]) await ctx.db.insert("domainEvents", {
      tenantId: f.tenantId, entityType: "lead", entityId: String(f.owedDeal), eventType: "lead.created",
      occurredAt: from + 100, source: "system", ...fields,
    });
  });
}
function logColumns(row: Answer["rows"][number]) {
  if (row.kind !== "event") throw new Error("Expected event");
  return { _id: row._id, occurredAt: row.occurredAt, entityType: row.entityType, entityId: row.entityId,
    actorUserId: row.actorUserId, teamMemberId: row.teamMemberId, actorName: row.actorName,
    eventType: row.eventType, label: row.label, source: row.source, fromStatus: row.fromStatus, toStatus: row.toStatus };
}

it("registers exactly one read-only admin tool", () => {
  expect(adminReportListTools).toHaveLength(1);
  expect(adminReportListTools[0]).toMatchObject({ name: "magnus_report_list", identityArg: "caller",
    annotations: { readOnlyHint: true, openWorldHint: false }, metadata: { roles: ["tenant_master", "tenant_admin"] } });
});

describe("page parity", () => {
  it("pages 60 open deals across stages, in the page's order, including its next steps and ages", async () => {
    const f = await callsFixture();
    await f.t.run(async ctx => {
      const { _id, _creationTime, ...base } = (await ctx.db.get("opportunities", f.owedDeal))!;
      void _id; void _creationTime;
      for (let index = 0; index < 58; index++) await ctx.db.insert("opportunities", {
        ...base, stage: OPEN_PIPELINE_STAGES[index % OPEN_PIPELINE_STAGES.length],
        createdAt: from - Math.floor(((index * 7) % 58) / 3) * DAY,
      });
      await ctx.db.patch("opportunities", f.owedDeal, { nextMeetingAt: now + DAY });
      await ctx.db.insert("followUps", { tenantId: f.tenantId, opportunityId: f.owedDeal, leadId: base.leadId,
        closerId: f.beto, type: "manual_reminder", status: "pending", reason: "admin_initiated", createdAt: from, reminderScheduledAt: now + 2 * DAY });
    });
    const expected = await allPublic(cursor => f.web.query(api.reports.pipeline.listOpenDeals, { paginationOpts: { cursor, numItems: 10 } }));
    const { rows, pages } = await allTool(f, { list: "pipeline_open_deals", limit: 25 });
    expect(rows).toHaveLength(60);
    expect(new Set(rows.map(row => row.kind === "deal" && row.opportunityId)).size).toBe(60);
    expect(rows).toEqual(expected.map(row => ({ ...row, kind: "deal", leadName: untrusted(row.leadName),
      closerName: row.closerName === null ? null : untrusted(row.closerName), ageDays: Math.max(0, (now - row.createdAt) / DAY),
      nextStep: pipelineNextStep(row, now), openInMagnus: expect.stringContaining(`/workspace/opportunities/${row.opportunityId}`) })));
    expect(pages.at(-1)?.isPartial).toBe(false);
  });

  it("pages owed calls with the original endedBy after the clock advances", async () => {
    const f = await callsFixture();
    const notEnded = await f.t.run(async ctx => {
      const { _id, _creationTime, ...base } = (await ctx.db.get("meetings", f.owed))!;
      void _id; void _creationTime;
      for (let index = 0; index < 30; index++) await ctx.db.insert("meetings", { ...base, scheduledAt: from + index * 60_000 });
      return ctx.db.insert("meetings", { ...base, scheduledAt: now - 10 * 60_000, durationMinutes: 30 });
    });
    const expected = await allPublic(cursor => f.web.query(api.reports.pipeline.listOwedCalls, { endedBy: now, paginationOpts: { cursor, numItems: 10 } }));
    const first = await f.t.query(run, { caller: f.caller, list: "pipeline_owed_calls", limit: 7 });
    vi.setSystemTime(now + DAY);
    const rest = await allTool(f, { list: "pipeline_owed_calls", limit: 7, cursor: first.cursor! });
    const rows = [...first.rows, ...rest.rows];
    expect(rows).toHaveLength(expected.length);
    expect(rest.pages.every(page => page.endedBy === now)).toBe(true);
    expect(rows).toEqual(expected.map(row => ({ ...row, kind: "owed_call", closerName: untrusted(row.closerName), leadName: untrusted(row.leadName),
      ageDays: Math.max(0, (now - row.endsAt) / DAY), openInMagnus: expect.stringContaining(`/workspace/pipeline/meetings/${row.meetingId}`) })));
    expect(rows.some(row => row.kind === "owed_call" && row.meetingId === notEnded)).toBe(false);
    expect(new Set(rows.map(row => row.kind === "owed_call" && row.meetingId)).size).toBe(rows.length);
  });

  it.each([false, true])("pages Log with its range, member and record-type filters (filtered=%s)", async filtered => {
    const f = await callsFixture();
    await seedLog(f);
    const filters = filtered ? { teamMemberId: f.memberA, entityType: "meeting" as const } : {};
    const expected = await allPublic(cursor => f.web.query(api.reports.log.listLog, { startDate: from, endDate: to, ...filters, paginationOpts: { cursor, numItems: 10 } }));
    const { rows } = await allTool(f, { list: "log", range, ...filters, limit: 25 });
    expect(rows.map(logColumns)).toEqual(expected.map(row => {
      const by = row.source === "closer" ? "closer" : row.source === "admin" ? "admin" : "integration";
      return { _id: row._id, occurredAt: row.occurredAt, entityType: row.entityType, entityId: row.entityId,
        actorUserId: row.actorUserId ?? null, teamMemberId: row.teamMemberId ?? null, actorName: row.actorName ? untrusted(row.actorName) : null,
        eventType: untrusted(row.eventType, by), label: untrusted(row.label, by), source: row.source,
        fromStatus: row.fromStatus ? untrusted(row.fromStatus, by) : null, toStatus: row.toStatus ? untrusted(row.toStatus, by) : null };
    }));
    expect(new Set(rows.map(row => row.kind === "event" && row._id)).size).toBe(rows.length);
    const json = JSON.stringify(rows);
    for (const privateText of ["metadata", "Private note", "secret@example.com", "+15555551234", "receiptUrl", "referenceCode"]) expect(json).not.toContain(privateText);
  });

  it("pages a member's work log, including legacy login events and system or other actors' member events", async () => {
    const f = await callsFixture();
    await seedLog(f);
    const expected = await allPublic(cursor => f.web.query(api.reports.log.listMemberLog, { startDate: from, endDate: to,
      teamMemberId: f.memberA, actorUserId: f.ana, paginationOpts: { cursor, numItems: 10 } }));
    const { rows } = await allTool(f, { list: "member_log", range, memberId: f.memberA, limit: 5 });
    expect(rows.map(row => row.kind === "event" && row._id)).toEqual(expected.map(row => row._id));
    expect(rows.length).toBe(33);
    expect(rows.every(row => row.kind === "event" && (row.actorName === null || row.actorName.by === "person"))).toBe(true);
  });

  it("keeps the look-further-back cursor on empty scan pages", async () => {
    const f = await callsFixture();
    const match = await f.t.run(async ctx => {
      const match = await ctx.db.insert("domainEvents", { tenantId: f.tenantId, entityType: "payment", entityId: f.firstPayment,
        eventType: "payment.recorded", occurredAt: from, source: "admin" });
      for (let index = 0; index < 510; index++) await ctx.db.insert("domainEvents", { tenantId: f.tenantId,
        entityType: "meeting", entityId: f.owed, eventType: "meeting.created", occurredAt: from + index + 1, source: "pipeline" });
      return match;
    });
    const first = await f.t.query(run, { caller: f.caller, list: "log", range, entityType: "payment" });
    const publicFirst = await f.web.query(api.reports.log.listLog, { startDate: from, endDate: to, entityType: "payment", paginationOpts: { numItems: 10, cursor: null } });
    expect(first.rows).toEqual(publicFirst.page);
    expect(first).toMatchObject({ isPartial: true, reasons: ["scan_limit"], sourceIsPartial: false });
    expect(first.cursor).toBeTypeOf("string");
    const { rows } = await allTool(f, { list: "log", range, entityType: "payment", cursor: first.cursor! });
    expect(rows.map(row => row.kind === "event" && row._id)).toEqual([match]);
  });

  it("returns the page's deal chain, historical closer, rebook/move links, per-currency credit and deal names", async () => {
    const f = await callsFixture();
    for (const opportunityId of [f.won, f.rebookDeal]) {
      const expected = await f.web.query(api.reports.attribution.getDealChain, { opportunityId });
      const names = await f.web.query(api.reports.attribution.getDealNames, { opportunityIds: [opportunityId] });
      const { rows, pages } = await allTool(f, { list: "deal_credits", opportunityId, limit: 2 });
      const identityShape = (person: { name: string; teamMemberId: string | null }) => ({ ...person, name: untrusted(person.name),
        openInMagnus: expect.stringContaining(person.teamMemberId ? `/workspace/reports/people/${person.teamMemberId}` : "/workspace/reports/attribution") });
      expect(pages[0].deal).toEqual({ opportunityId, stage: expected.stage, outcome: expected.outcome,
        personName: untrusted(expected.personName), openInMagnus: expect.stringContaining(`/workspace/opportunities/${opportunityId}`) });
      expect(pages[0].dealNames).toEqual(names.map(row => ({ ...row, name: untrusted(row.name), openInMagnus: expect.stringContaining(`/workspace/opportunities/${row.opportunityId}`) })));
      expect(rows).toEqual([
        ...expected.credits.map(row => ({ ...row, ...identityShape(row), kind: "credit", sourceKind: untrusted(row.sourceKind, "integration"),
          meetingOpenInMagnus: row.meetingId ? expect.stringContaining(`/workspace/pipeline/meetings/${row.meetingId}`) : null })),
        ...expected.meetings.map(row => ({ ...row, kind: "meeting", closer: identityShape(row.closer), openInMagnus: expect.stringContaining(`/workspace/pipeline/meetings/${row.id}`),
          replacesOpenInMagnus: row.replacesMeetingId ? expect.stringContaining(`/workspace/pipeline/meetings/${row.replacesMeetingId}`) : null })),
        ...expected.payments.map(row => ({ ...row, kind: "payment", closer: row.closer ? identityShape(row.closer) : null, openInMagnus: expect.stringContaining(`/workspace/billing/${row.id}`) })),
      ]);
      expect(pages.every(page => page.sourceIsPartial === expected.isTruncated)).toBe(true);
      expect(new Set(rows.map(row => "id" in row && row.id)).size).toBe(rows.length);
    }
  });

  it("discovers the same non-contact booking fields as the Scorecard picker", async () => {
    const f = await callsFixture();
    await f.t.run(async ctx => {
      const eventTypeConfigId = (await ctx.db.get("opportunities", f.won))!.eventTypeConfigId!;
      for (let index = 0; index < 32; index++) await ctx.db.insert("eventTypeFieldCatalog", {
        tenantId: f.tenantId, eventTypeConfigId, fieldKey: `key${index}`, currentLabel: `Question ${index}`, firstSeenAt: from, lastSeenAt: to, valueType: "string" });
      for (const currentLabel of ["Email address", "Phone", "Instagram handle"]) await ctx.db.insert("eventTypeFieldCatalog", {
        tenantId: f.tenantId, eventTypeConfigId, fieldKey: currentLabel, currentLabel, firstSeenAt: from, lastSeenAt: to });
    });
    const expected = await f.web.query(api.reports.formFields.getFieldCatalog, {});
    const { rows } = await allTool(f, { list: "report_fields", limit: 25 });
    expect(rows).toHaveLength(32);
    expect(rows).toEqual(expected.map(row => ({ ...row, kind: "field", currentLabel: untrusted(row.currentLabel, "integration"),
      eventTypeName: row.eventTypeName === null ? null : untrusted(row.eventTypeName, "integration"), valueType: row.valueType === null ? null : untrusted(row.valueType, "integration"),
      openInMagnus: expect.stringContaining("/workspace/reports/scorecard") })));
  });
});

describe("access, cursors and bounding", () => {
  it.each(lists)("refuses a closer for %s", async list => {
    const f = await adminFixture();
    await expect(f.t.query(run, { caller: adminCaller(f.orgId, "claude-ai", "user_alex"), list })).rejects.toThrow("mcp.role_not_allowed");
  });
  it("answers mcp.not_found for another workspace's member, actor or deal IDs", async () => {
    const f = await adminFixture();
    const other = await seedAdminTenant(f.t, { orgId: "other", prefix: "other_" });
    const ids = await f.t.run(async ctx => {
      const memberId = await ctx.db.insert("teamMembers", { tenantId: other.tenantId, displayName: "Secret member", createdAt: from, updatedAt: from });
      const leadId = await ctx.db.insert("leads", { tenantId: other.tenantId, firstSeenAt: from, updatedAt: from, status: "active",
        ...qualifiedLifecycle(from), fullName: "Secret person" });
      const opportunityId = await ctx.db.insert("opportunities", { tenantId: other.tenantId, leadId, stage: "booked", outcome: "open", createdAt: from, updatedAt: from });
      return { memberId, opportunityId };
    });
    for (const args of [
      { list: "member_log", memberId: ids.memberId }, { list: "log", teamMemberId: ids.memberId },
      { list: "log", actorUserId: other.closerId }, { list: "deal_credits", opportunityId: ids.opportunityId },
    ] satisfies Args[]) await expect(f.t.query(run, { caller: adminCaller(f.orgId), ...args })).rejects.toThrow("mcp.not_found");
  });
  it("rejects mismatched actor/member filters and missing required drill-down IDs", async () => {
    const f = await callsFixture();
    for (const args of [
      { list: "log", teamMemberId: f.memberA, actorUserId: f.beto },
      { list: "member_log", memberId: f.memberA, actorUserId: f.beto },
      { list: "member_log" }, { list: "deal_credits" },
    ] satisfies Args[]) await expect(f.t.query(run, { caller: f.caller, ...args })).rejects.toThrow(/mcp.invalid_(filter|argument)/);
  });
  it.each(lists)("rejects a malformed cursor for %s", async list => {
    const f = await adminFixture();
    await expect(f.t.query(run, { caller: adminCaller(f.orgId), list, cursor: "broken" })).rejects.toThrow("mcp.invalid_cursor");
  });
  it("rejects raw cursor corruption, filter changes and cross-workspace cursor reuse", async () => {
    const f = await callsFixture();
    const first = await f.t.query(run, { caller: f.caller, list: "pipeline_open_deals", limit: 1 });
    const badRaw: unknown = JSON.parse(first.cursor!);
    await expect(f.t.query(run, { caller: f.caller, list: "pipeline_open_deals", cursor: JSON.stringify({ ...badRaw as object, position: "malformed" }) })).rejects.toThrow("mcp.invalid_cursor");
    await expect(f.t.query(run, { caller: f.caller, list: "pipeline_owed_calls", cursor: first.cursor! })).rejects.toThrow("mcp.invalid_cursor");
    const other = await seedAdminTenant(f.t, { orgId: "org_other_cursor", prefix: "cursor_" });
    await expect(f.t.query(run, { caller: adminCaller(other.orgId, "claude-ai", "cursor_user_jordan"), list: "pipeline_open_deals", cursor: first.cursor! })).rejects.toThrow("mcp.invalid_cursor");
  });
  it("bounds long multibyte names, hides contact fallbacks and keeps every source row while shortening pages", async () => {
    const f = await callsFixture();
    await f.t.run(async ctx => {
      const { _id, _creationTime, ...base } = (await ctx.db.get("opportunities", f.owedDeal))!;
      void _id; void _creationTime;
      await ctx.db.patch("leads", base.leadId, { fullName: '界"\\'.repeat(1000) + " private@example.com" });
      await ctx.db.patch("users", f.beto, { fullName: "+15555551234 private@example.com" });
      for (let index = 0; index < 58; index++) await ctx.db.insert("opportunities", { ...base, createdAt: from + index });
    });
    const { rows, pages } = await allTool(f, { list: "pipeline_open_deals", limit: 25 });
    expect(rows).toHaveLength(60);
    expect(new Set(rows.map(row => row.kind === "deal" && row.opportunityId)).size).toBe(60);
    for (const page of pages) expect(gatewayAnswerBytes(page)).toBeLessThanOrEqual(MAX_ASSISTANT_ANSWER_BYTES);
    expect(JSON.stringify(rows)).not.toContain("private@example.com");
    expect(JSON.stringify(rows)).not.toContain("+15555551234");
    expect(rows.every(row => row.kind === "deal" && row.leadName.by === "person" && row.closerName?.by === "person")).toBe(true);
  });
});


describe("read argument errors", () => {
  it("names the required member and rejects malformed or wrong-table IDs", async () => {
    const f = await callsFixture();
    await expect(f.t.query(run, { caller: f.caller, list: "member_log" })).rejects.toThrow("memberId is required");
    for (const opportunityId of ["garbage", f.memberA]) await expect(f.t.query(run, { caller: f.caller, list: "deal_credits", opportunityId })).rejects.toThrow("mcp.invalid_argument");
  });
  it.each([
    ["2026-02-30", "2026-03-01"], ["11/05/2026", "2026-11-06"],
    ["2026-09-04", "2026-09-01"], ["2026-09-01", "2027-01-01"],
  ])("rejects invalid custom log range %s through %s", async (startDate, endDateInclusive) => {
    const f = await callsFixture();
    await expect(f.t.query(run, { caller: f.caller, list: "log", range: { kind: "custom", startDate, endDateInclusive } })).rejects.toThrow("range.invalid");
  });
  it("labels a partially filled scan-limited log page", async () => {
    const f = await callsFixture();
    await f.t.run(async ctx => {
      for (let index = 0; index < 510; index++) await ctx.db.insert("domainEvents", { tenantId: f.tenantId,
        entityType: index === 505 ? "payment" : "meeting", entityId: f.owed, eventType: "meeting.created", occurredAt: from + index, source: "pipeline" });
    });
    const page = await f.t.query(run, { caller: f.caller, list: "log", range, entityType: "payment" });
    expect(page.rows).toHaveLength(1);
    expect(page).toMatchObject({ isPartial: true, reasons: ["scan_limit"] });
  });
});
