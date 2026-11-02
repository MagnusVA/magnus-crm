import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { createLiveReadState, readLiveQueryRows } from "../lib/liveQueryBounds";
import { dealStageOf } from "../opportunities/stages";
import { isPersonLoss } from "../reporting/lib/outcomeDerivation";
import { readCloserMeetingDeals, readCountedCloserPayments } from "./dashboard";
import {
  currencyAmountsValidator,
  dealLastActivityAt,
  dealNextStepValidator,
  dealProgramKey,
  loadDealNextStep,
  loadPrograms,
  NO_PROGRAM,
  personNameOf,
  programFallbackNames,
  sumByCurrency,
} from "./pipelineDeals";

// My Pipeline's desk (.impeccable/surfaces/app-workspace-closer-pipeline-page-tsx.md):
// the month's cash and wins, and the closer's open deals by program. The
// client passes the business month, as Today does, so no query reads the
// clock; the previous month's cash is a second getMonthCash call.

function assertRange(startDate: number, endDate: number) {
  if (!(startDate < endDate)) {
    throw new Error("startDate must be earlier than endDate");
  }
}

/**
 * The closer's cash in [startDate, endDate): the payments attributed to them,
 * not disputed and not deposits (as Today's Performance counts them), summed
 * by currency and by program and currency, the currency with the most
 * payments first. Amounts are never added or compared across currencies. `isPartial` says the payment read stopped at its cap.
 */
export const getMonthCash = query({
  args: { startDate: v.number(), endDate: v.number() },
  returns: v.object({
    currencies: currencyAmountsValidator,
    programs: v.array(
      v.object({
        programKey: v.string(),
        programName: v.union(v.string(), v.null()),
        /** The program's own currency, from its settings, if it has one. */
        defaultCurrency: v.union(v.string(), v.null()),
        currencies: currencyAmountsValidator,
        paymentCount: v.number(),
      }),
    ),
    paymentCount: v.number(),
    isPartial: v.boolean(),
  }),
  handler: async (ctx, { startDate, endDate }) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);
    assertRange(startDate, endDate);

    const { payments, isPaymentDataTruncated } = await readCountedCloserPayments(ctx, {
      tenantId,
      userId,
      startDate,
      endDate,
    });

    const byProgram = new Map<string, Array<Doc<"paymentRecords">>>();
    const fallbackNames = new Map<string, string | null>();
    for (const payment of payments) {
      const key = payment.programId;
      byProgram.set(key, [...(byProgram.get(key) ?? []), payment]);
      fallbackNames.set(key, payment.programName);
    }
    const programInfo = await loadPrograms(ctx, tenantId, fallbackNames);

    return {
      currencies: sumByCurrency(payments),
      programs: [...byProgram].map(([programKey, programPayments]) => ({
        programKey,
        programName: programInfo.get(programKey)?.name ?? null,
        defaultCurrency: programInfo.get(programKey)?.defaultCurrency ?? null,
        currencies: sumByCurrency(programPayments),
        paymentCount: programPayments.length,
      })),
      paymentCount: payments.length,
      isPartial: isPaymentDataTruncated,
    };
  },
});

/**
 * The closer's wins in [startDate, endDate), by program: the deals behind
 * their calls scheduled in the range, as Today's Performance counts them, so
 * the two pages agree. `decided` is the wins plus the deals a person lost;
 * the losses a no-show or cancellation wrote are left out, as in the win
 * rate. `isPartial` says the meeting read stopped at its bound.
 */
export const getMonthWins = query({
  args: { startDate: v.number(), endDate: v.number() },
  returns: v.object({
    won: v.number(),
    decided: v.number(),
    programs: v.array(v.object({ programKey: v.string(), won: v.number() })),
    isPartial: v.boolean(),
  }),
  handler: async (ctx, { startDate, endDate }) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);
    assertRange(startDate, endDate);

    const { deals, isMeetingDataTruncated } = await readCloserMeetingDeals(
      ctx,
      tenantId,
      userId,
      startDate,
      endDate,
    );
    let won = 0;
    let lost = 0;
    const wonByProgram = new Map<string, number>();
    for (const deal of deals) {
      const { stage, outcome } = dealStageOf(deal);
      if (stage === "closed" && outcome === "won") {
        won += 1;
        const key = dealProgramKey(deal);
        wonByProgram.set(key, (wonByProgram.get(key) ?? 0) + 1);
      } else if (isPersonLoss(deal)) {
        lost += 1;
      }
    }
    return {
      won,
      decided: won + lost,
      programs: [...wonByProgram].map(([programKey, count]) => ({ programKey, won: count })),
      isPartial: isMeetingDataTruncated,
    };
  },
});

// The open positions a closer's deals reach. Closers own no Qualified deals
// (pipelineTabs.ts).
const OPEN_STAGES = ["booked", "call_held", "follow_up"] as const;
// A closer who never recorded old calls carries hundreds of open Booked
// deals (316 on a real closer in Nov 2026), and the page exists to clear
// them, so the bound sits well above that. Each deal costs two more reads
// (its person and its open tasks).
const MAX_OPEN_DEALS = 750;
const OPEN_DEAL_BYTES = 2 * 1024 * 1024;
// The closed deals counted for each program's footer.
const MAX_CLOSED_DEALS = 1000;
const CLOSED_DEAL_BYTES = 3 * 1024 * 1024;

/**
 * The closer's open deals (Booked, Call held, Follow-up), each with its
 * person, program (sold, else first booked, else none), stage and next step,
 * and every program the closer has deals in, with its open and closed
 * counts for the section footer. Open deals show their current state,
 * whatever month the page reads.
 *
 * Reads at most MAX_OPEN_DEALS open deals (`isPartial`) and MAX_CLOSED_DEALS
 * closed ones (`isClosedPartial`), each through the closer's stage index.
 */
export const getOpenDeals = query({
  args: {},
  returns: v.object({
    deals: v.array(
      v.object({
        opportunityId: v.id("opportunities"),
        leadId: v.id("leads"),
        personName: v.string(),
        position: v.union(v.literal("booked"), v.literal("call_held"), v.literal("follow_up")),
        programKey: v.string(),
        nextStep: dealNextStepValidator,
        /** The meeting behind `nextStep.callAt`: where a call that passed with no result is recorded. */
        nextMeetingId: v.union(v.id("meetings"), v.null()),
        lastActivityAt: v.number(),
      }),
    ),
    programs: v.array(
      v.object({
        programKey: v.string(),
        programName: v.union(v.string(), v.null()),
        open: v.number(),
        closed: v.number(),
      }),
    ),
    isPartial: v.boolean(),
    isClosedPartial: v.boolean(),
  }),
  handler: async (ctx) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    const openState = createLiveReadState();
    const open: Array<Doc<"opportunities"> & { position: (typeof OPEN_STAGES)[number] }> = [];
    let isPartial = false;
    for (const stage of OPEN_STAGES) {
      const read = await readLiveQueryRows(
        ctx.db
          .query("opportunities")
          .withIndex("by_tenantId_assignedCloserId_stage_outcome_createdAt", (q) =>
            q
              .eq("tenantId", tenantId)
              .eq("assignedCloserId", userId)
              .eq("stage", stage)
              .eq("outcome", "open"),
          )
          .order("desc"),
        MAX_OPEN_DEALS - open.length,
        openState,
        OPEN_DEAL_BYTES,
      );
      open.push(...read.rows.map((deal) => ({ ...deal, position: stage })));
      if (read.capped) {
        isPartial = true;
        break;
      }
    }

    const closedState = createLiveReadState();
    const closed: Array<Doc<"opportunities">> = [];
    let isClosedPartial = false;
    for (const outcome of ["won", "lost"] as const) {
      const read = await readLiveQueryRows(
        ctx.db
          .query("opportunities")
          .withIndex("by_tenantId_assignedCloserId_stage_outcome_createdAt", (q) =>
            q
              .eq("tenantId", tenantId)
              .eq("assignedCloserId", userId)
              .eq("stage", "closed")
              .eq("outcome", outcome),
          ),
        MAX_CLOSED_DEALS - closed.length,
        closedState,
        CLOSED_DEAL_BYTES,
      );
      closed.push(...read.rows);
      if (read.capped) {
        isClosedPartial = true;
        break;
      }
    }

    const counts = new Map<string, { open: number; closed: number }>();
    const count = (key: string) => {
      const entry = counts.get(key) ?? { open: 0, closed: 0 };
      counts.set(key, entry);
      return entry;
    };
    for (const deal of open) count(dealProgramKey(deal)).open += 1;
    for (const deal of closed) count(dealProgramKey(deal)).closed += 1;
    const programInfo = await loadPrograms(
      ctx,
      tenantId,
      programFallbackNames(closed, programFallbackNames(open)),
    );

    const deals = await Promise.all(
      open.map(async (deal) => {
        const [lead, nextStep] = await Promise.all([
          ctx.db.get("leads", deal.leadId),
          loadDealNextStep(ctx, deal),
        ]);
        return {
          opportunityId: deal._id,
          leadId: deal.leadId,
          personName: personNameOf(lead && lead.tenantId === tenantId ? lead : null),
          position: deal.position,
          programKey: dealProgramKey(deal),
          nextStep,
          nextMeetingId: deal.nextMeetingId ?? null,
          lastActivityAt: dealLastActivityAt(deal),
        };
      }),
    );

    return {
      deals,
      programs: [...counts].map(([programKey, entry]) => ({
        programKey,
        programName: programKey === NO_PROGRAM ? null : (programInfo.get(programKey)?.name ?? null),
        ...entry,
      })),
      isPartial,
      isClosedPartial,
    };
  },
});
