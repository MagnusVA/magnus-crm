import { v } from "convex/values";
import { internalAction } from "../_generated/server";

export const postConfirmation = internalAction({
  args: {
    tenantId: v.id("tenants"),
    opportunityId: v.id("opportunities"),
    leadId: v.id("leads"),
  },
  handler: async (_ctx, args) => {
    console.log("[Slack:Notify] Phase 3 stub postConfirmation", args);
  },
});
