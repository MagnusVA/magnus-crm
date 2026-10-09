import { convexTest } from "convex-test";
import aggregate from "@convex-dev/aggregate/test";
import workpool from "@convex-dev/workpool/test";
import schema from "../convex/schema";
import { convexTestModules } from "../convex/test.setup";

export async function bookingHarness() {
  const t = convexTest(schema, convexTestModules);
  for (const name of ["webhookWorkpool", "reportingWorkpool"])
    workpool.register(t, name);
  for (const name of [
    "meetingsByStatus",
    "opportunityByStatus",
    "leadTimeline",
    "slackQualificationsByUser",
    "slackQualificationsByTime",
    "paymentSums",
    "customerConversions",
    "billingPaymentsByStatus",
    "billingPaymentsByStatusProgram",
    "billingPaymentsByStatusType",
    "billingPaymentsByStatusProgramType",
  ])
    aggregate.register(t, name);
  const tenantId = await t.run(async (ctx) => {
    const tenantId = await ctx.db.insert("tenants", {
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
