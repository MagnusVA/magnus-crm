import { v } from "convex/values";
import { z } from "zod";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  action,
  env,
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { expectedError, rejectRequest } from "../lib/observability/errors";
import { log } from "../lib/observability/log";
import { PERMISSIONS } from "../lib/permissions";
import { requireTenantUser } from "../requireTenantUser";
import { requireTenantUserFromAction } from "../requireTenantUserFromAction";
import {
  MAX_PAYMENT_READ_ATTEMPTS,
  disputeAccessValidator,
  paymentConnectionErrorValidator,
  paymentConnectionStatusValidator,
  providerEnvironmentValidator,
} from "./schema";
import { parseWebhookSecret } from "./signature";
import {
  WHOP_API_VERSION_DATE,
  WhopRequestError,
  reportWhopRequestError,
  whopRequest,
  type WhopCredentials,
} from "./whop/client";

const settingsRoles = [...PERMISSIONS["settings:manage"]];
const rotationWindowMs = 24 * 60 * 60 * 1000;
const webhookEvents = [
  "payment.created",
  "payment.succeeded",
  "payment.failed",
  "payment.pending",
  "payment.canceled",
  "refund.created",
  "refund.updated",
  "dispute.created",
  "dispute.updated",
  "dispute_alert.created",
];

const connectionIdValidator = v.id("tenantPaymentConnections");
const connectionView = v.object({
  connectionId: connectionIdValidator,
  status: paymentConnectionStatusValidator,
  environment: providerEnvironmentValidator,
  accountId: v.string(),
  accountTitle: v.optional(v.string()),
  keyLast4: v.string(),
  disputeAccess: disputeAccessValidator,
  hasWebhookSecret: v.boolean(),
  webhookUrl: v.union(v.string(), v.null()),
  autoImportAfter: v.number(),
  lastWebhookAt: v.optional(v.number()),
  lastSuccessfulSweepAt: v.optional(v.number()),
  lastFullScanAt: v.optional(v.number()),
  lastErrorCode: v.optional(paymentConnectionErrorValidator),
  unreadablePayments: v.number(),
  connectedAt: v.number(),
  connectedByUserId: v.id("users"),
  webhookEvents: v.array(v.string()),
});

export async function findConnection(
  ctx: QueryCtx | MutationCtx,
  tenantId: Id<"tenants">,
  environment: WhopCredentials["environment"],
) {
  return ctx.db
    .query("tenantPaymentConnections")
    .withIndex("by_tenantId_and_provider_and_environment", (q) =>
      q.eq("tenantId", tenantId).eq("provider", "whop").eq("environment", environment),
    )
    .unique();
}

export async function requireWhopConnection(
  ctx: QueryCtx | MutationCtx,
  tenantId: Id<"tenants">,
  connectionId: Id<"tenantPaymentConnections">,
): Promise<Doc<"tenantPaymentConnections">> {
  const row = await ctx.db.get("tenantPaymentConnections", connectionId);
  if (!row || row.tenantId !== tenantId || row.provider !== "whop") {
    const reject = "scheduler" in ctx ? rejectRequest : expectedError;
    throw reject("whop.connection_not_found", "Whop connection not found.");
  }
  return row;
}

export const getConnection = query({
  args: { environment: providerEnvironmentValidator },
  returns: v.union(v.null(), connectionView),
  handler: async (ctx, { environment }) => {
    const { tenantId } = await requireTenantUser(ctx, settingsRoles);
    const row = await findConnection(ctx, tenantId, environment);
    if (!row) return null;
    const unreadablePayments = await ctx.db.query("providerPayments")
      .withIndex("by_connectionId_and_retryReadAttempts", (q) =>
        q.eq("connectionId", row._id).eq("retryReadAttempts", MAX_PAYMENT_READ_ATTEMPTS))
      .take(100);

    return {
      connectionId: row._id,
      status: row.status,
      environment: row.environment,
      accountId: row.accountId,
      accountTitle: row.accountTitle,
      keyLast4: row.keyLast4,
      disputeAccess: row.disputeAccess,
      hasWebhookSecret: parseWebhookSecret(row.webhookSecret) !== null,
      webhookUrl: env.CONVEX_SITE_URL
        ? `${env.CONVEX_SITE_URL}/webhooks/whop?c=${row._id}`
        : null,
      autoImportAfter: row.autoImportAfter,
      lastWebhookAt: row.lastWebhookAt,
      lastSuccessfulSweepAt: row.lastSuccessfulSweepAt,
      lastFullScanAt: row.lastFullScanAt,
      lastErrorCode: row.lastErrorCode,
      unreadablePayments: unreadablePayments.length,
      connectedAt: row.connectedAt,
      connectedByUserId: row.connectedByUserId,
      webhookEvents,
    };
  },
});

function otherWhopEnvironment(environment: WhopCredentials["environment"]) {
  return environment === "live" ? "sandbox" : "live";
}

function rejectOtherConnectedEnvironment(status?: Doc<"tenantPaymentConnections">["status"]) {
  if (status === "connected") {
    throw rejectRequest("whop.other_environment_connected", "Disconnect the other Whop environment first.");
  }
}

const connectArgs = {
  apiKey: v.string(),
  accountId: v.string(),
  environment: providerEnvironmentValidator,
};
const saveConnectionArgs = {
  ...connectArgs, accountTitle: v.optional(v.string()), disputeAccess: disputeAccessValidator,
};

const paymentProbe = z.object({
  data: z.array(z.object({ account_id: z.string().nullable() })).max(1),
});
const accountProbe = z.object({ id: z.string(), title: z.string() });

const whopErrorMessages = {
  unauthorized: "Whop rejected the API key.",
  forbidden: "The Whop API key is missing the required read permission.",
  account_mismatch: "The Whop API key does not match this account ID.",
  provider_unavailable: "Whop could not verify the request. Try again.",
};

export function rejectWhopRequest(code: keyof typeof whopErrorMessages) {
  return rejectRequest(`whop.${code}`, whopErrorMessages[code]);
}

export function whopRequestFailure(error: unknown) {
  if (error instanceof WhopRequestError) {
    if (error.code === "unauthorized" || error.code === "forbidden") return error.code;
  }
  return "provider_unavailable";
}

async function readAccount(
  credentials: WhopCredentials,
  tenantId: Id<"tenants">,
) {
  // The account key can identify itself, but account-read scope is optional.
  try {
    const account = accountProbe.safeParse(
      await whopRequest(credentials, "/accounts/me", { timeoutMs: 5_000 }),
    );
    if (account.success) return account.data;
    log.warn("whop.account.read_skipped", { tenantId, code: "unexpected_response" });
  } catch (error) {
    log.warn("whop.account.read_skipped", {
      tenantId,
      code: error instanceof WhopRequestError ? error.code : "provider_unavailable",
    });
  }
  return null;
}

export const connect = action({
  args: connectArgs,
  returns: connectionIdValidator,
  handler: async (ctx, args): Promise<Id<"tenantPaymentConnections">> => {
    const { tenantId } = await requireTenantUserFromAction(ctx, settingsRoles);
    const other = await ctx.runQuery(api.payments.connection.getConnection, {
      environment: otherWhopEnvironment(args.environment),
    });
    rejectOtherConnectedEnvironment(other?.status);
    const apiKey = args.apiKey.trim();
    const accountId = args.accountId.trim();
    if (!/^[\x21-\x7e]{8,1024}$/.test(apiKey)) throw rejectWhopRequest("unauthorized");
    if (!/^biz_[a-zA-Z0-9_]{1,124}$/.test(accountId)) throw rejectWhopRequest("account_mismatch");

    const credentials = {
      apiKey,
      environment: args.environment,
      apiVersionDate: WHOP_API_VERSION_DATE,
    };
    let payments: unknown;
    try {
      // The payments list requires payment:basic:read. Payer email separately
      // requires member:email:read, which this probe cannot confirm.
      payments = await whopRequest(credentials, "/payments", {
        query: { account_id: accountId, first: 1 },
        timeoutMs: 10_000,
      });
    } catch (error) {
      const code = whopRequestFailure(error);
      if (code === "provider_unavailable") reportWhopRequestError("whop.connection.probe_failed", error, { tenantId });
      if (code === "forbidden") {
        const account = await readAccount(credentials, tenantId);
        if (account && account.id !== accountId) throw rejectWhopRequest("account_mismatch");
      }
      throw rejectWhopRequest(code);
    }
    const probe = paymentProbe.safeParse(payments);
    if (!probe.success) throw rejectWhopRequest("provider_unavailable");
    if (probe.data.data.some((payment) => payment.account_id !== accountId)) {
      throw rejectWhopRequest("account_mismatch");
    }

    const account = await readAccount(credentials, tenantId);
    if (account && account.id !== accountId) throw rejectWhopRequest("account_mismatch");

    let disputeAccess: "ok" | "forbidden" = "ok";
    for (const path of ["/disputes", "/dispute_alerts"]) {
      try {
        const result = await whopRequest(credentials, path, {
          query: { account_id: accountId, first: 1 },
          timeoutMs: 5_000,
        });
        if (!z.object({ data: z.array(z.unknown()).max(1) }).safeParse(result).success) {
          throw new WhopRequestError("unexpected_response");
        }
      } catch (error) {
        const code = whopRequestFailure(error);
        if (code !== "forbidden") {
          if (code === "provider_unavailable") reportWhopRequestError("whop.connection.dispute_probe_failed", error, { tenantId });
          throw rejectWhopRequest(code);
        }
        disputeAccess = "forbidden";
      }
    }

    return ctx.runMutation(internal.payments.connection.saveConnection, {
      apiKey,
      accountId,
      environment: args.environment,
      accountTitle: account?.title.slice(0, 512),
      disputeAccess,
    });
  },
});

export const saveConnection = internalMutation({
  args: saveConnectionArgs,
  returns: connectionIdValidator,
  handler: async (ctx, args) => {
    const actor = await requireTenantUser(ctx, settingsRoles);
    const prior = await findConnection(ctx, actor.tenantId, args.environment);
    // Payments, receipts and bindings reference this row for their account.
    if (prior && prior.accountId !== args.accountId) {
      throw rejectRequest(
        "whop.account_mismatch",
        "This Whop connection is tied to a different account.",
      );
    }

    const other = await findConnection(ctx, actor.tenantId, otherWhopEnvironment(args.environment));
    rejectOtherConnectedEnvironment(other?.status);
    for (const status of ["connected", "invalid_key"] as const) {
      const holders = await ctx.db.query("tenantPaymentConnections")
        .withIndex("by_provider_and_environment_and_accountId_and_status", (q) => q
          .eq("provider", "whop").eq("environment", args.environment)
          .eq("accountId", args.accountId).eq("status", status))
        .take(2);
      if (holders.some((holder) => holder.tenantId !== actor.tenantId)) {
        throw rejectRequest("whop.account_in_use", "This Whop account is already connected to another workspace.");
      }
    }

    const now = Date.now();
    const credentials = {
      credentialKind: "account_key" as const,
      apiKey: args.apiKey,
      keyLast4: args.apiKey.slice(-4),
      apiVersionDate: WHOP_API_VERSION_DATE,
      status: "connected" as const,
      disputeAccess: args.disputeAccess,
      // Intake and sweep jobs use this timestamp to reject stale reads.
      connectedAt: prior ? Math.max(now, prior.connectedAt + 1) : now,
      connectedByUserId: actor.userId,
    };
    const connectionId = prior
      ? prior._id
      : await ctx.db.insert("tenantPaymentConnections", {
          ...credentials,
          tenantId: actor.tenantId,
          provider: "whop",
          environment: args.environment,
          accountId: args.accountId,
          accountTitle: args.accountTitle,
          autoImportAfter: now,
        });
    if (prior) {
      await ctx.db.patch("tenantPaymentConnections", connectionId, {
        ...credentials,
        accountTitle: args.accountTitle ?? prior.accountTitle,
        disconnectedAt: undefined,
        lastErrorCode: undefined,
        lastErrorAt: undefined,
        sweepToken: undefined,
        sweepUntil: undefined,
        nextRequestAt: undefined,
      });
    }
    log.info("whop.connection.saved", {
      tenantId: actor.tenantId,
      connectionId,
      reason: prior ? "reconnected" : "connected",
    });
    return connectionId;
  },
});

export const setWebhookSecret = mutation({
  args: { connectionId: connectionIdValidator, webhookSecret: v.string() },
  returns: v.null(),
  handler: async (ctx, { connectionId, webhookSecret }) => {
    const { tenantId } = await requireTenantUser(ctx, settingsRoles);
    const row = await requireWhopConnection(ctx, tenantId, connectionId);
    if (row.status === "disconnected") {
      throw rejectRequest("whop.disconnected", "Connect Whop before setting a webhook secret.");
    }
    const secret = webhookSecret.trim();
    if (!parseWebhookSecret(secret)) {
      throw rejectRequest("whop.invalid_webhook_secret", "Enter the webhook secret from Whop.");
    }
    if (row.webhookSecret === secret) return null;
    await ctx.db.patch("tenantPaymentConnections", row._id, {
      webhookSecret: secret,
      previousWebhookSecret: row.webhookSecret,
      previousWebhookSecretUntil: row.webhookSecret ? Date.now() + rotationWindowMs : undefined,
    });
    log.info("whop.connection.webhook_secret_saved", {
      tenantId,
      connectionId,
      reason: row.webhookSecret ? "rotated" : "set",
    });
    return null;
  },
});

export const disconnect = mutation({
  args: { connectionId: connectionIdValidator },
  returns: v.null(),
  handler: async (ctx, { connectionId }) => {
    const { tenantId } = await requireTenantUser(ctx, settingsRoles);
    const row = await requireWhopConnection(ctx, tenantId, connectionId);
    if (row.status === "disconnected") return null;

    await ctx.db.patch("tenantPaymentConnections", row._id, {
      status: "disconnected",
      disconnectedAt: Date.now(),
      apiKey: "",
      keyLast4: "",
      webhookSecret: undefined,
      previousWebhookSecret: undefined,
      previousWebhookSecretUntil: undefined,
      sweepToken: undefined,
      sweepUntil: undefined,
      nextRequestAt: undefined,
      lastErrorCode: undefined,
      lastErrorAt: undefined,
    });
    log.info("whop.connection.disconnected", { tenantId, connectionId });
    return null;
  },
});
