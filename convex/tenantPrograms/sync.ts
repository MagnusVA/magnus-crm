import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation } from "../_generated/server";

const SYNC_BATCH_SIZE = 100;

export const syncRenamedProgram = internalMutation({
  args: {
    programId: v.id("tenantPrograms"),
    paymentCursor: v.optional(v.string()),
    customerCursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const program = await ctx.db.get(args.programId);
    if (!program) {
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
      await ctx.db.patch(payment._id, {
        programName: program.name,
      });
      syncedPayments += 1;
    }

    let syncedCustomers = 0;
    for (const customer of customerPage.page) {
      if (customer.programName === program.name) {
        continue;
      }
      await ctx.db.patch(customer._id, {
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

    return {
      syncedPayments,
      syncedCustomers,
      hasMore,
    };
  },
});
