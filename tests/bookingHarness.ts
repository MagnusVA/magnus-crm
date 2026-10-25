import { convexTest } from "convex-test";
import aggregate from "@convex-dev/aggregate/test";
import workpool from "@convex-dev/workpool/test";
import schema from "../convex/schema";
import { convexTestModules } from "../convex/test.setup";
import type { Id } from "../convex/_generated/dataModel";
import type { MutationCtx } from "../convex/_generated/server";

/** Registers the workpools and aggregates the app mounts. */
export function registerComponents(t: ReturnType<typeof convexTest>) {
  for (const name of ["webhookWorkpool", "reportingWorkpool"])
    workpool.register(t, name);
  for (const name of [
    "meetingsByStatus",
    "opportunityByStage",
    "openDealAging",
    "personLosses",
    "leadStageEntries",
    "activityEventCounts",
    "slackQualificationsByUser",
    "slackQualificationsByTime",
    "paymentSums",
    "prospectConversions",
    "leadGenDealsByWorker",
    "billingPaymentsByStatus",
    "billingPaymentsByStatusProgram",
    "billingPaymentsByStatusType",
    "billingPaymentsByStatusProgramType",
    "resparkPool",
    "resparkResultsByWorker",
  ])
    aggregate.register(t, name);
}

// `transactionLimits: true` makes every function fail the way a deployment
// would when it exceeds Convex's per-transaction read and write limits.
export async function bookingHarness(options: { transactionLimits?: boolean } = {}) {
  const t = convexTest({
    schema,
    modules: convexTestModules,
    transactionLimits: options.transactionLimits ?? false,
  });
  registerComponents(t);
  const tenantId = await t.run(async (ctx) => {
    const tenantId = await ctx.db.insert("tenants", {
      businessDayAppliedVersion: 0,
      companyName: "Test",
      contactEmail: "admin@example.com",
      workosOrgId: "org_test",
      status: "active",
      inviteExpiresAt: 0,
      createdBy: "test",
    });
    await ctx.db.insert("users", {
      tenantId,
      workosUserId: "user_admin",
      email: "admin@example.com",
      role: "tenant_admin",
      isActive: true,
    });
    await ctx.db.insert("users", {
      tenantId,
      workosUserId: "user_closer",
      email: "closer@example.com",
      role: "closer",
      isActive: true,
      calendlyUserUri: "https://api.calendly.com/users/closer",
    });
    return tenantId;
  });
  return {
    t,
    tenantId,
    admin: t.withIdentity({ subject: "user_admin", org_id: "org_test" }),
    closer: t.withIdentity({ subject: "user_closer", org_id: "org_test" }),
  };
}
/** The lifecycle fields every lead has, for a person who reached Qualified at `at`. */
export function qualifiedLifecycle(at: number) {
  return {
    lifecycleStage: "qualified" as const,
    lifecycleStageEnteredAt: { qualified: at },
    disposition: "open" as const,
  };
}

export function bookingPayload(key: string, email = "lead@example.com") {
  return {
    uri: `https://api.calendly.com/scheduled_events/${key}/invitees/person`,
    email,
    name: "Test Lead",
    scheduled_event: {
      uri: `https://api.calendly.com/scheduled_events/${key}`,
      event_type: "https://api.calendly.com/event_types/test",
      start_time: "2026-10-01T12:00:00Z",
      end_time: "2026-10-01T12:30:00Z",
      event_memberships: [
        {
          user: "https://api.calendly.com/users/closer",
          user_email: "closer@example.com",
          user_name: "Closer",
        },
      ],
    },
  };
}

/** Maps a Calendly event type to a new program. The pipeline holds an unlinked
 * host's booking for review only on a program event type, and ignores it on
 * any other. */
export async function mapEventTypeToProgram(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  calendlyEventTypeUri: string,
) {
  const admin = await ctx.db.query("users")
    .withIndex("by_workosUserId", (q) => q.eq("workosUserId", "user_admin")).unique();
  const programId = await ctx.db.insert("tenantPrograms", {
    tenantId,
    name: "Program",
    normalizedName: "program",
    createdAt: Date.now(),
    createdByUserId: admin!._id,
    updatedAt: Date.now(),
  });
  await ctx.db.insert("eventTypeConfigs", {
    tenantId,
    calendlyEventTypeUri,
    displayName: "Strategy call",
    createdAt: Date.now(),
    bookingProgramId: programId,
    bookingProgramName: "Program",
    bookingProgramMappingStatus: "mapped",
  });
}
