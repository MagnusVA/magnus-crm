import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation } from "../_generated/server";
import { log } from "../lib/observability/log";

const SYNC_BATCH_SIZE = 100;

export const syncRenamedProgram = internalMutation({
  args: {
    programId: v.id("tenantPrograms"),
    paymentCursor: v.optional(v.string()),
    customerCursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const program = await ctx.db.get("tenantPrograms", args.programId);
    if (!program) {
      log.warn("program.rename_sync.skipped", {
        programId: args.programId,
        reason: "program_not_found",
      });
      return { syncedPayments: 0, syncedCustomers: 0, hasMore: false };
    }

    const [paymentPage, customerPage] = await Promise.all([
      ctx.db
        .query("paymentRecords")
        .withIndex("by_tenantId_and_programId_and_recordedAt", (q) =>
          q.eq("tenantId", program.tenantId).eq("programId", program._id),
        )
        .paginate({
          cursor: args.paymentCursor ?? null,
          numItems: SYNC_BATCH_SIZE,
        }),
      ctx.db
        .query("customers")
        .withIndex("by_tenantId_and_programId", (q) =>
          q.eq("tenantId", program.tenantId).eq("programId", program._id),
        )
        .paginate({
          cursor: args.customerCursor ?? null,
          numItems: SYNC_BATCH_SIZE,
        }),
    ]);

    let syncedPayments = 0;
    for (const payment of paymentPage.page) {
      if (payment.programName === program.name) {
        continue;
      }
      await ctx.db.patch("paymentRecords", payment._id, {
        programName: program.name,
      });
      syncedPayments += 1;
    }

    let syncedCustomers = 0;
    for (const customer of customerPage.page) {
      if (customer.programName === program.name) {
        continue;
      }
      await ctx.db.patch("customers", customer._id, {
        programName: program.name,
      });
      syncedCustomers += 1;
    }

    const hasMore = !paymentPage.isDone || !customerPage.isDone;
    if (hasMore) {
      await ctx.scheduler.runAfter(
        0,
        internal.tenantPrograms.sync.syncRenamedProgram,
        {
          programId: args.programId,
          paymentCursor: paymentPage.isDone
            ? undefined
            : paymentPage.continueCursor,
          customerCursor: customerPage.isDone
            ? undefined
            : customerPage.continueCursor,
        },
      );
    }

    // The last batch logs `completed`, so a chain that stops early shows up
    // as a rename with batch lines and no completed line.
    log.info(
      hasMore ? "program.rename_sync.batch" : "program.rename_sync.completed",
      {
        tenantId: program.tenantId,
        programId: program._id,
        syncedPayments,
        syncedCustomers,
        hasMore,
      },
    );

    return {
      syncedPayments,
      syncedCustomers,
      hasMore,
    };
  },
});
