import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { createLiveReadState, readLiveQueryRows } from "../lib/liveQueryBounds";

// What My Pipeline reads about a closer's deals: the program each one is
// grouped under, the person's name, the next step, and the bounded read of
// every deal the closer owns. The desk (pipelineDesk.ts) and the lookup
// (pipeline.ts) share them.

/** The key of the "No program" group: deals with no program sold or booked. */
export const NO_PROGRAM = "none";

/**
 * The program a deal is grouped under: the program sold, else the program
 * first booked, else NO_PROGRAM. A tenantPrograms id otherwise.
 */
export function dealProgramKey(
  deal: Pick<Doc<"opportunities">, "soldProgramId" | "firstBookingProgramId">,
): string {
  return deal.soldProgramId ?? deal.firstBookingProgramId ?? NO_PROGRAM;
}

/** The name the deal itself carries for its program, if any. */
function dealProgramName(
  deal: Pick<Doc<"opportunities">, "soldProgramId" | "soldProgramName" | "firstBookingProgramName">,
): string | null {
  return deal.soldProgramId ? (deal.soldProgramName ?? null) : (deal.firstBookingProgramName ?? null);
}

export type ProgramInfo = { name: string | null; defaultCurrency: string | null };

/**
 * Each program's name and default currency, read once from tenantPrograms
 * so a renamed program shows one name; `fallback` (the name on a deal or
 * payment) covers a program row that is gone. NO_PROGRAM has neither.
 */
export async function loadPrograms(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  fallback: Map<string, string | null>,
): Promise<Map<string, ProgramInfo>> {
  const programs = new Map<string, ProgramInfo>();
  for (const [key, name] of fallback) {
    if (key === NO_PROGRAM) {
      programs.set(key, { name: null, defaultCurrency: null });
      continue;
    }
    const id = ctx.db.normalizeId("tenantPrograms", key);
    const program = id ? await ctx.db.get("tenantPrograms", id) : null;
    const own = program && program.tenantId === tenantId ? program : null;
    programs.set(key, {
      name: own ? own.name : name,
      defaultCurrency: own?.defaultCurrency?.trim().toUpperCase() || null,
    });
  }
  return programs;
}

/** The program keys of `deals`, each with the name a deal carries for it. */
export function programFallbackNames(
  deals: Array<Doc<"opportunities">>,
  into = new Map<string, string | null>(),
): Map<string, string | null> {
  for (const deal of deals) {
    const key = dealProgramKey(deal);
    if (!into.get(key)) into.set(key, dealProgramName(deal));
  }
  return into;
}

/** The person's name as rows show it. */
export function personNameOf(lead: Pick<Doc<"leads">, "fullName" | "email"> | null): string {
  return lead?.fullName ?? lead?.email ?? "Unknown";
}

/**
 * What an open deal's next step is made of (CONTEXT.md, "Task"): the time
 * of its next scheduled call (`callAt`), and its open task: the soonest
 * call-back or text-back, else a scheduling link waiting on the person to
 * book. Both come back side by side, because only the client knows whether
 * the call has passed: queries don't read the clock. The client shows the
 * call while it is ahead, else the task, else "No next step"
 * (lib/closer-pipeline.ts, `resolveNextStep`). The system's stale-deal nudge
 * isn't a step the closer planned, so it isn't a task here.
 */
export const dealTaskStepValidator = v.union(
  v.null(),
  v.object({
    kind: v.literal("task"),
    method: v.union(v.literal("call"), v.literal("text")),
    dueAt: v.union(v.number(), v.null()),
  }),
  v.object({
    kind: v.literal("link"),
    reschedule: v.boolean(),
    sentAt: v.number(),
  }),
);

export const dealNextStepValidator = v.object({
  callAt: v.union(v.number(), v.null()),
  task: dealTaskStepValidator,
});

export type DealTaskStep = Infer<typeof dealTaskStepValidator>;
export type DealNextStep = Infer<typeof dealNextStepValidator>;

// Far above the open tasks one deal has.
const PENDING_TASK_SCAN = 20;

/** The deal's next call and open task (see `dealNextStepValidator`): one indexed read. */
export async function loadDealNextStep(
  ctx: QueryCtx,
  deal: Pick<Doc<"opportunities">, "_id" | "nextMeetingAt">,
): Promise<DealNextStep> {
  const pending = await ctx.db
    .query("followUps")
    .withIndex("by_opportunityId_and_status_and_reason", (q) =>
      q.eq("opportunityId", deal._id).eq("status", "pending"),
    )
    .take(PENDING_TASK_SCAN);
  return { callAt: deal.nextMeetingAt ?? null, task: nextStepFromTasks(pending) };
}

/** The open task the deal's pending tasks give: the soonest call-back or text-back, else a link. */
export function nextStepFromTasks(pending: Array<Doc<"followUps">>): DealTaskStep {
  const task = pickOpenTask(pending);
  if (!task) return null;
  if (task.type === "manual_reminder") {
    return {
      kind: "task",
      method: task.contactMethod === "text" ? "text" : "call",
      dueAt: task.reminderScheduledAt ?? null,
    };
  }
  return { kind: "link", reschedule: task.reason === "no_show_follow_up", sentAt: task.createdAt };
}

/** The pending task that is the deal's next step (see `nextStepFromTasks`), or null. */
export function pickOpenTask(pending: Array<Doc<"followUps">>): Doc<"followUps"> | null {
  let task: Doc<"followUps"> | null = null;
  let link: Doc<"followUps"> | null = null;
  for (const followUp of pending) {
    if (followUp.status !== "pending") continue;
    if (followUp.type === "manual_reminder") {
      if (followUp.reason === "stale_opportunity_nudge") continue;
      // The soonest due; a task with no due time comes after any dated one.
      const due = followUp.reminderScheduledAt ?? Number.POSITIVE_INFINITY;
      if (task === null || due < (task.reminderScheduledAt ?? Number.POSITIVE_INFINITY)) {
        task = followUp;
      }
    } else {
      // A reschedule link (after a no-show) before an ordinary one, then the newest.
      const rank = (row: Doc<"followUps">) => (row.reason === "no_show_follow_up" ? 1 : 0);
      if (
        link === null ||
        rank(followUp) > rank(link) ||
        (rank(followUp) === rank(link) && followUp.createdAt > link.createdAt)
      ) {
        link = followUp;
      }
    }
  }
  return task ?? link;
}

/** When something last happened on the deal, for the lookup's sort and column. */
export function dealLastActivityAt(
  deal: Pick<Doc<"opportunities">, "latestActivityAt" | "updatedAt" | "createdAt">,
): number {
  return deal.latestActivityAt ?? Math.max(deal.updatedAt, deal.createdAt);
}

// Every deal the closer owns, newest first. Far above what a closer works in
// a year; the byte budget keeps the read within a live query's limits.
export const MAX_CLOSER_DEAL_SCAN = 1000;
const CLOSER_DEAL_SCAN_BYTES = 3 * 1024 * 1024;

/**
 * The closer's deals, newest created first, up to MAX_CLOSER_DEAL_SCAN rows
 * or the byte budget. `capped` says older deals were left out.
 */
export async function readCloserDeals(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  closerId: Id<"users">,
  maxRows = MAX_CLOSER_DEAL_SCAN,
  byteBudget = CLOSER_DEAL_SCAN_BYTES,
): Promise<{ deals: Array<Doc<"opportunities">>; capped: boolean }> {
  const read = await readLiveQueryRows(
    ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_assignedCloserId_and_createdAt", (q) =>
        q.eq("tenantId", tenantId).eq("assignedCloserId", closerId),
      )
      .order("desc"),
    maxRows,
    createLiveReadState(),
    byteBudget,
  );
  return { deals: read.rows, capped: read.capped };
}

/**
 * Amounts by currency, the most payments first; never added, or compared,
 * across currencies.
 */
export const currencyAmountsValidator = v.array(
  v.object({ currency: v.string(), amountMinor: v.number(), paymentCount: v.number() }),
);

export type CurrencyAmount = Infer<typeof currencyAmountsValidator>[number];

/** Sums payments by currency, the currency with the most payments first, then by code. */
export function sumByCurrency(
  payments: Array<Pick<Doc<"paymentRecords">, "amountMinor" | "currency">>,
): CurrencyAmount[] {
  const byCurrency = new Map<string, CurrencyAmount>();
  for (const payment of payments) {
    const currency = payment.currency.trim().toUpperCase();
    const entry = byCurrency.get(currency) ?? { currency, amountMinor: 0, paymentCount: 0 };
    entry.amountMinor += payment.amountMinor;
    entry.paymentCount += 1;
    byCurrency.set(currency, entry);
  }
  return [...byCurrency.values()].sort(
    (a, b) => b.paymentCount - a.paymentCount || a.currency.localeCompare(b.currency),
  );
}
