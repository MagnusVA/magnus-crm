import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { rejectRequest } from "../lib/observability/errors";

export function validateTimezone(timeZone: string): string {
  // Browsers can return an IANA alias; canonicalize it before checking the list.
  let canonical: string;
  try {
    canonical = new Intl.DateTimeFormat("en", { timeZone }).resolvedOptions()
      .timeZone;
  } catch {
    throw rejectRequest("timezone.invalid", "Choose a valid IANA time zone.");
  }
  if (
    canonical !== "UTC" &&
    !Intl.supportedValuesOf("timeZone").includes(canonical)
  ) {
    throw rejectRequest(
      "timezone.invalid",
      "Choose a supported IANA time zone.",
    );
  }
  return canonical;
}

export const updateMyTimezone = mutation({
  args: { timeZone: v.string() },
  returns: v.null(),
  handler: async (ctx, { timeZone }) => {
    const { userId } = await requireTenantUser(ctx, [
      "closer",
      "tenant_admin",
      "tenant_master",
      "lead_generator",
    ]);
    await ctx.db.patch("users", userId, {
      timezone: validateTimezone(timeZone),
    });
    return null;
  },
});
