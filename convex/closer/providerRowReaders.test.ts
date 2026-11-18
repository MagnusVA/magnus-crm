import { afterEach, describe, expect, it, vi } from "vitest";
import { insertProgram } from "../../tests/closerPipelineDeskFixtures";
import { insertCloserMeeting, insertTask } from "../../tests/closerPipelineFixtures";
import { insertDeal } from "../../tests/dealStageFixtures";
import { seedLeadGenReads } from "../../tests/leadGenReadFixtures";
import { adminFixture } from "../../tests/mcpAdminFixtures";
import { callTool, createMcpHarness, mcpConnect, testCaller } from "../../tests/mcpHarness";
import { storeProofFile } from "../../tests/proofFixtures";
import { seedProviderRow } from "../../tests/providerRowFixtures";
import { insertDealEvent } from "../../tests/stageLabelFixtures";
import { api, internal } from "../_generated/api";
import { buildLeadCustomerSearchText } from "../leadCustomers/searchText";
import { safeText } from "../mcp/reports/output";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const RESERVED_REASON = "payment_excluded";
const LOSS_LABEL = "Payment taken out";

async function fixture(status: "payment_received" | "lost") {
  const f = await adminFixture();
  const ids = await f.t.run(async (ctx) => {
    const opportunityId = await insertDeal(ctx, {
      tenantId: f.tenantId,
      status,
      fields: {
        assignedCloserId: f.closerId,
        ...(status === "lost" ? {
          lostReason: RESERVED_REASON,
          lostAt: Date.now(),
          lostByUserId: f.adminId,
        } : {}),
      },
    });
    const deal = await ctx.db.get("opportunities", opportunityId);
    if (!deal) throw new Error("Expected the seeded deal");
    const meetingId = await insertCloserMeeting(ctx, {
      tenantId: f.tenantId,
      opportunityId,
      closerId: f.closerId,
      scheduledAt: Date.now() - 60 * 60 * 1000,
      status: "held",
    });
    const followUpId = await insertTask(ctx, {
      opportunityId,
      type: "manual_reminder",
      reason: "closer_initiated",
      status: "completed",
    });
    return { opportunityId, meetingId, followUpId, leadId: deal.leadId };
  });
  return { ...f, ...ids };
}

async function details(f: Awaited<ReturnType<typeof fixture>>) {
  const [meeting, reminder, pipelineReminder, deal, person] = await Promise.all([
    f.closerWeb.query(api.closer.meetingDetail.getMeetingDetail, { meetingId: f.meetingId }),
    f.closerWeb.query(api.closer.reminderDetail.getReminderDetail, { followUpId: f.followUpId }),
    f.adminWeb.query(api.pipeline.reminderDetail.getAdminReminderDetail, { followUpId: f.followUpId }),
    f.closerWeb.query(api.opportunities.detailQuery.getOpportunityDetail, { opportunityId: f.opportunityId }),
    f.adminWeb.query(api.leadCustomers.detail.getEntityDetail, { leadId: f.leadId }),
  ]);
  if (!meeting || !reminder || !pipelineReminder || !deal || person?.kind !== "detail") {
    throw new Error("Expected all five detail results");
  }
  return { meeting, reminder, pipelineReminder, deal, person };
}

describe("Whop payment readers", () => {
  it("reads confirmed and automatic payments on the meeting, reminders, deal and person", async () => {
    const f = await fixture("payment_received");
    const { confirmedId, automaticId } = await seedPayments(f);
    const { meeting, reminder, pipelineReminder, deal, person } = await details(f);
    for (const detail of [meeting, reminder, pipelineReminder]) {
      const confirmed = detail.payments.find((payment) => payment._id === confirmedId);
      const automatic = detail.payments.find((payment) => payment._id === automaticId);
      expect(confirmed).toMatchObject({
        recordedByUserId: f.adminId,
        recordedByName: "Jordan Park",
        providerByline: "Confirmed from Whop by Jordan Park",
      });
      expect(automatic).toMatchObject({
        attributedCloserId: f.closerId,
        recordedByName: null,
        recordedBy: null,
        providerByline: "Recorded automatically from Whop",
      });
      expect(automatic?.recordedByUserId).toBeUndefined();
    }
    for (const payments of [deal.payments, person.payments]) {
      expect(payments).toHaveLength(2);
      expect(payments).toEqual(expect.arrayContaining([
        expect.objectContaining({ _id: confirmedId, origin: "provider", recordedVia: "provider" }),
        expect.objectContaining({ _id: automaticId, origin: "provider", recordedVia: "provider" }),
      ]));
    }
  });

  it("keeps the Whop provenance when a closer attaches proof to an automatic payment", async () => {
    const f = await fixture("payment_received");
    const { automaticId } = await seedPayments(f);
    const storageId = await storeProofFile(f.t, { contents: "Whop receipt" });
    const result = await f.t.mutation(internal.mcp.tools.payments.attachProofToPayment, {
      caller: testCaller(f.orgId),
      paymentId: automaticId,
      storedFile: { storageId },
    });

    expect(result).toMatchObject({ ok: true, via: "whop" });
    const payment = await f.t.run((ctx) => ctx.db.get("paymentRecords", automaticId));
    expect(payment).toMatchObject({ origin: "provider", recordedVia: "provider", proofFileId: storageId });
    expect(payment?.recordedByUserId).toBeUndefined();
  });

  it("marks both payments as Whop in MCP queue and lookup", async () => {
    const f = await fixture("payment_received");
    const { confirmedId, automaticId } = await seedPayments(f);
    const tool = (name: string, args: Record<string, unknown>) =>
      callTool(f.t, f.adminToken, f.adminSession, name, args);

    const queue = await tool("magnus_queue", { queue: "payments_to_review", closerId: f.closerId });
    expect(queue.isError, queue.text).toBe(false);
    expect(queue.data).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id: confirmedId, closerId: f.closerId, flags: expect.objectContaining({ via: "whop", recorded_by_you: true }) }),
        expect.objectContaining({ id: automaticId, closerId: f.closerId, flags: expect.objectContaining({ via: "whop", recorded_by_you: false }) }),
      ]),
    });
    for (const id of [confirmedId, automaticId]) {
      const lookup = await tool("magnus_lookup", { kind: "payment", id });
      expect(lookup.isError, lookup.text).toBe(false);
      expect(lookup.data).toMatchObject({
        items: [{ id, via: "whop", ids: { closerId: f.closerId } }],
      });
      expect(JSON.stringify(lookup.data)).not.toMatch(/unknown|missing user|recordedBy/i);
    }
  });
});

async function seedPayments(f: Awaited<ReturnType<typeof fixture>>) {
  return await f.t.run(async (ctx) => {
    const programId = await insertProgram(ctx, f.tenantId, f.adminId, "Program A");
    const input = {
      tenantId: f.tenantId,
      opportunityId: f.opportunityId,
      closerId: f.closerId,
      programId,
      amountMinor: 20_000,
    };
    const confirmedId = await seedProviderRow(ctx, {
      ...input,
      meetingId: f.meetingId,
      recordedAt: Date.now() - 20 * 60 * 1000,
      recorder: f.adminId,
    });
    const automaticId = await seedProviderRow(ctx, {
      ...input,
      recordedAt: Date.now(),
      recorder: "absent",
    });
    return { confirmedId, automaticId };
  });
}

function expectLabeled(value: unknown) {
  const encoded = JSON.stringify(value);
  expect(encoded).toContain(LOSS_LABEL);
  expect(encoded).not.toContain(RESERVED_REASON);
}

describe("reserved loss reason readers", () => {
  it("labels the stored loss on every detail result, in deal history and in search text", async () => {
    const f = await fixture("lost");
    const eventId = await f.t.run(async (ctx) => {
      await ctx.db.patch("followUps", f.followUpId, {
        completionOutcome: "lost",
        completionNote: RESERVED_REASON,
      });
      return await insertDealEvent(ctx, f.opportunityId, {
        eventType: "opportunity.stage_changed",
        fromStatus: "follow_up",
        toStatus: "closed",
        occurredAt: Date.now(),
        reason: RESERVED_REASON,
        metadata: { fromOutcome: "open", toOutcome: "lost" },
      });
    });
    const detail = await details(f);
    for (const result of Object.values(detail)) expectLabeled(result);
    expect(detail.deal.events.find((event) => event._id === eventId)?.reason).toBe(LOSS_LABEL);
    expect(detail.reminder.followUp.completionNote).toBe(LOSS_LABEL);
    expect(detail.pipelineReminder.followUp.completionNote).toBe(LOSS_LABEL);
    const searchText = await f.t.run(async (ctx) => {
      const lead = await ctx.db.get("leads", f.leadId);
      const opportunity = await ctx.db.get("opportunities", f.opportunityId);
      if (!lead || !opportunity) throw new Error("Expected the seeded person and deal");
      return buildLeadCustomerSearchText({ lead, identifiers: [], opportunities: [opportunity], meetingIds: [f.meetingId] });
    });
    expect(searchText).toContain(LOSS_LABEL.toLowerCase());
    expect(searchText).not.toContain(RESERVED_REASON);
  });

  it("labels the loss on the respark card, person panel and MCP output", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const h = await createMcpHarness();
    const f = await seedLeadGenReads(h);
    const itemId = f.items[0]._id;
    await h.t.run((ctx) => ctx.db.patch("opportunities", f.dealId, { lostReason: RESERVED_REASON }));
    const batch = await f.sofia.query(api.respark.queries.getMyResparkBatch, {});
    const panel = await f.sofia.query(api.respark.queries.getResparkPersonPanel, { itemId });
    const token = await h.signToken("user_sofia", { org_id: f.orgId });
    const { sessionId } = await mcpConnect(h.t, token);
    const result = await callTool(h.t, token, sessionId, "magnus_respark_person", { itemIds: [itemId] });
    expect(result.isError, result.text).toBe(false);

    expectLabeled(batch?.items.find((item) => item.itemId === itemId));
    expectLabeled(panel);
    expectLabeled(result.data);
    expectLabeled(safeText({ deals: [{ lostReason: RESERVED_REASON, reason: RESERVED_REASON }] }));
  });
});
