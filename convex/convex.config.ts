import aggregate from "@convex-dev/aggregate/convex.config";
import migrations from "@convex-dev/migrations/convex.config";
import workOSAuthKit from "@convex-dev/workos-authkit/convex.config";
import { defineApp } from "convex/server";
import { v } from "convex/values";

// Environment variables, read through `env` from `_generated/server`.
// Deploys check that required variables are set, so set a new required
// variable on every deployment before deploying code that declares it.
const app = defineApp({
  env: {
    WORKOS_CLIENT_ID: v.string(),
    WORKOS_API_KEY: v.string(),
    SYSTEM_ADMIN_ORG_ID: v.string(),
    INVITE_SIGNING_SECRET: v.string(),
    CALENDLY_CLIENT_ID: v.string(),
    CALENDLY_CLIENT_SECRET: v.string(),

    // Public app URL for links in Slack messages.
    APP_URL: v.optional(v.string()),
    // Public app URL for invite links and the Calendly OAuth redirect.
    NEXT_PUBLIC_APP_URL: v.optional(v.string()),

    LINK_PORTAL_SESSION_SECRET: v.optional(v.string()),
    LINK_PORTAL_PASSWORD_PEPPER: v.optional(v.string()),

    SLACK_CLIENT_ID: v.optional(v.string()),
    SLACK_CLIENT_SECRET: v.optional(v.string()),
    SLACK_REDIRECT_URI: v.optional(v.string()),
    SLACK_SIGNING_SECRET: v.optional(v.string()),
    // Set only while rotating the signing secret.
    SLACK_SIGNING_SECRET_PREVIOUS: v.optional(v.string()),
    SLACK_STATE_SIGNING_SECRET: v.optional(v.string()),
  },
});
app.use(workOSAuthKit);
app.use(migrations);
app.use(aggregate, { name: "meetingsByStatus" });
app.use(aggregate, { name: "paymentSums" });
app.use(aggregate, { name: "opportunityByStatus" });
app.use(aggregate, { name: "leadTimeline" });
app.use(aggregate, { name: "customerConversions" });
app.use(aggregate, { name: "slackQualificationsByUser" });
app.use(aggregate, { name: "slackQualificationsByTime" });
app.use(aggregate, { name: "billingPaymentsByStatus" });
app.use(aggregate, { name: "billingPaymentsByStatusProgram" });
app.use(aggregate, { name: "billingPaymentsByStatusType" });
app.use(aggregate, { name: "billingPaymentsByStatusProgramType" });

export default app;
