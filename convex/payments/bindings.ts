import { v, type Infer } from "convex/values";
import { z } from "zod";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { expectedError, rejectRequest } from "../lib/observability/errors";
import { log } from "../lib/observability/log";
import { paymentTypeValidator } from "../lib/paymentTypes";
import { PERMISSIONS } from "../lib/permissions";
import { requireTenantUser, type TenantUserResult } from "../requireTenantUser";
import { requireTenantUserFromAction } from "../requireTenantUserFromAction";
import { rejectWhopRequest, requireWhopConnection, whopRequestFailure } from "./connection";
import { refreshProviderPaymentReview } from "./match";
import { WhopRequestError } from "./whop/client";
import { WhopAccountMismatch, whopFetch } from "./whop/connectionFetch";

const settingsRoles = [...PERMISSIONS["settings:manage"]];
const pageSize = 50;
// Matching can read a person's deal and payment history for each fact.
const refreshPageSize = 10;
const cursorLimit = 2_048;
const connectionArgs = { connectionId: v.id("tenantPaymentConnections") };
const mappingKindValidator = v.union(v.literal("product_program"), v.literal("variant_type"));
const mappingFields = {
  bindingId: v.id("paymentProviderBindings"),
  externalId: v.string(),
  externalTitle: v.optional(v.string()),
  version: v.number(),
  setAt: v.number(),
  setByUserId: v.id("users"),
};
const productMapping = v.object({
  ...mappingFields,
  kind: v.literal("product_program"),
  programId: v.id("tenantPrograms"),
});
const variantMapping = v.object({
  ...mappingFields,
  kind: v.literal("variant_type"),
  paymentType: paymentTypeValidator,
  laterPaymentType: v.optional(paymentTypeValidator),
});
const mappingView = v.union(productMapping, variantMapping);

type MappingKind = Infer<typeof mappingKindValidator>;
type Mapping = Infer<typeof mappingView>;
type MappingValue = Extract<Doc<"paymentProviderBindings">["binding"], { kind: MappingKind }>;
type ConnectionId = Id<"tenantPaymentConnections">;
type TenantId = Id<"tenants">;

function isMappingKind(kind: Doc<"paymentProviderBindings">["kind"]): kind is MappingKind {
  return kind === "product_program" || kind === "variant_type";
}

function validExternalId(kind: MappingKind, id: string) {
  return kind === "product_program"
    ? /^prod_[a-zA-Z0-9_]{1,123}$/.test(id)
    : /^plan_[a-zA-Z0-9_]{1,123}$/.test(id);
}

function mappingIndex(
  ctx: QueryCtx | MutationCtx,
  tenantId: TenantId,
  connectionId: ConnectionId,
  kind: MappingKind,
  externalId: string,
  range: "exact" | "after",
) {
  return ctx.db.query("paymentProviderBindings")
    .withIndex("by_tenantId_and_connectionId_and_kind_and_externalId", (q) => {
      const prefix = q.eq("tenantId", tenantId).eq("connectionId", connectionId).eq("kind", kind);
      return range === "exact" ? prefix.eq("externalId", externalId) : prefix.gt("externalId", externalId);
    });
}

function latestMapping(
  ctx: QueryCtx | MutationCtx,
  tenantId: TenantId,
  connectionId: ConnectionId,
  kind: MappingKind,
  externalId: string,
) {
  return mappingIndex(ctx, tenantId, connectionId, kind, externalId, "exact").order("desc").first();
}

function toActiveMapping(row: Doc<"paymentProviderBindings"> | null): Mapping | null {
  if (!row?.enabled) return null;
  const { binding } = row;
  if (binding.kind !== "product_program" && binding.kind !== "variant_type") return null;
  return {
    bindingId: row._id,
    externalId: row.externalId,
    externalTitle: row.externalTitle,
    version: row.version,
    setAt: row.setAt,
    setByUserId: row.setByUserId,
    ...binding,
  };
}

export const listBindings = query({
  args: { ...connectionArgs, kind: mappingKindValidator, cursor: v.optional(v.string()) },
  returns: v.object({ bindings: v.array(mappingView), nextCursor: v.union(v.string(), v.null()) }),
  handler: async (ctx, { connectionId, kind, cursor }) => {
    const { tenantId } = await requireTenantUser(ctx, settingsRoles);
    await requireWhopConnection(ctx, tenantId, connectionId);
    if (cursor !== undefined && !validExternalId(kind, cursor)) {
      throw expectedError("whop.invalid_cursor", "Invalid Whop mapping cursor.");
    }

    const bindings: Mapping[] = [];
    let after = cursor ?? "";
    // Advance by distinct external ID so a long version history can't hide
    // the current binding or use up an entire page by itself.
    for (let scanned = 0; scanned < pageSize; scanned++) {
      const first = await mappingIndex(ctx, tenantId, connectionId, kind, after, "after").first();
      if (!first) return { bindings, nextCursor: null };
      after = first.externalId;
      const binding = toActiveMapping(await latestMapping(ctx, tenantId, connectionId, kind, after));
      if (binding) bindings.push(binding);
    }
    const next = await mappingIndex(ctx, tenantId, connectionId, kind, after, "after").first();
    return { bindings, nextCursor: next ? after : null };
  },
});

const refreshArgs = {
  ...connectionArgs,
  kind: mappingKindValidator,
  externalId: v.string(),
  cursor: v.union(v.string(), v.null()),
};
async function setMapping(
  ctx: MutationCtx,
  actor: TenantUserResult,
  args: { connectionId: ConnectionId; externalId: string; externalTitle?: string },
  binding: MappingValue,
) {
  const { tenantId, userId } = actor;
  const { connectionId, externalId } = args;
  if (!validExternalId(binding.kind, externalId)) {
    throw rejectRequest("whop.invalid_catalog_id", "Enter a valid Whop product or variant ID.");
  }
  const previous = await latestMapping(ctx, tenantId, connectionId, binding.kind, externalId);
  if (previous?.enabled) {
    await ctx.db.patch("paymentProviderBindings", previous._id, {
      enabled: false,
      disabledReason: "removed",
    });
  }
  const bindingId = await ctx.db.insert("paymentProviderBindings", {
    tenantId,
    connectionId,
    externalId,
    externalTitle: args.externalTitle?.trim().slice(0, 512) || previous?.externalTitle,
    kind: binding.kind,
    binding,
    enabled: true,
    version: (previous?.version ?? 0) + 1,
    setAt: Date.now(),
    setByUserId: userId,
  });
  await ctx.scheduler.runAfter(0, internal.payments.bindings.refreshMappingPayments, {
    connectionId,
    kind: binding.kind,
    externalId,
    cursor: null,
  });
  log.info("whop.binding.saved", { tenantId, connectionId, bindingId, kind: binding.kind });
  return bindingId;
}

export const setProductProgram = mutation({
  args: {
    ...connectionArgs,
    productId: v.string(),
    programId: v.id("tenantPrograms"),
    externalTitle: v.optional(v.string()),
  },
  returns: v.id("paymentProviderBindings"),
  handler: async (ctx, { connectionId, productId, programId, externalTitle }) => {
    const actor = await requireTenantUser(ctx, settingsRoles);
    await requireWhopConnection(ctx, actor.tenantId, connectionId);
    const program = await ctx.db.get("tenantPrograms", programId);
    if (!program || program.tenantId !== actor.tenantId) {
      throw rejectRequest("whop.program_not_found", "Program not found.");
    }
    return setMapping(
      ctx,
      actor,
      { connectionId, externalId: productId, externalTitle },
      { kind: "product_program", programId },
    );
  },
});

export const setVariantType = mutation({
  args: {
    ...connectionArgs,
    variantId: v.string(),
    paymentType: paymentTypeValidator,
    laterPaymentType: v.optional(paymentTypeValidator),
    externalTitle: v.optional(v.string()),
  },
  returns: v.id("paymentProviderBindings"),
  handler: async (ctx, { connectionId, variantId, paymentType, laterPaymentType, externalTitle }) => {
    const actor = await requireTenantUser(ctx, settingsRoles);
    await requireWhopConnection(ctx, actor.tenantId, connectionId);
    return setMapping(
      ctx,
      actor,
      { connectionId, externalId: variantId, externalTitle },
      { kind: "variant_type", paymentType, laterPaymentType },
    );
  },
});

export const removeBinding = mutation({
  args: { bindingId: v.id("paymentProviderBindings") },
  returns: v.null(),
  handler: async (ctx, { bindingId }) => {
    const { tenantId } = await requireTenantUser(ctx, settingsRoles);
    const row = await ctx.db.get("paymentProviderBindings", bindingId);
    if (!row || row.tenantId !== tenantId || !isMappingKind(row.kind)) {
      throw rejectRequest("whop.binding_not_found", "Whop mapping not found.");
    }
    await requireWhopConnection(ctx, tenantId, row.connectionId);
    if (!row.enabled) return null;

    await ctx.db.patch("paymentProviderBindings", bindingId, {
      enabled: false,
      disabledReason: "removed",
    });
    await ctx.scheduler.runAfter(0, internal.payments.bindings.refreshMappingPayments, {
      connectionId: row.connectionId,
      kind: row.kind,
      externalId: row.externalId,
      cursor: null,
    });
    log.info("whop.binding.removed", { tenantId, connectionId: row.connectionId, bindingId, kind: row.kind });
    return null;
  },
});

export const refreshMappingPayments = internalMutation({
  args: refreshArgs,
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const connection = await ctx.db.get("tenantPaymentConnections", args.connectionId);
    if (!connection || connection.provider !== "whop") return null;

    // The schema indexes connection and external payment ID. This cursor
    // stays stable when the matcher updates the review fields.
    const payments = await ctx.db.query("providerPayments")
      .withIndex("by_tenantId_and_connectionId_and_externalPaymentId", (q) =>
        q.eq("tenantId", connection.tenantId).eq("connectionId", connection._id),
      )
      .paginate({ cursor: args.cursor, numItems: refreshPageSize, maximumBytesRead: 512 * 1024 });
    for (const payment of payments.page) {
      const externalId = args.kind === "product_program" ? payment.productId : payment.variantId;
      if (externalId === args.externalId &&
          (payment.reviewState === "needs_person" || payment.reviewState === "historical")) {
        await refreshProviderPaymentReview(ctx, payment._id);
      }
    }
    if (!payments.isDone) {
      await ctx.scheduler.runAfter(0, internal.payments.bindings.refreshMappingPayments, {
        ...args, cursor: payments.continueCursor,
      });
    }
    return null;
  },
});

const catalogConnectionView = v.object({
  accountId: v.string(),
  connectedAt: v.number(),
});
const catalogMappingArgs = {
  ...connectionArgs,
  connectedAt: v.number(),
  productIds: v.array(v.string()),
  variantIds: v.array(v.string()),
};
async function requireCatalogConnection(ctx: QueryCtx, connectionId: ConnectionId) {
  const { tenantId } = await requireTenantUser(ctx, settingsRoles);
  const row = await requireWhopConnection(ctx, tenantId, connectionId);
  if (row.status !== "connected" || !row.apiKey) {
    throw expectedError("whop.disconnected", "Connect Whop before loading the catalog.");
  }
  return row;
}

export const readCatalogConnection = internalQuery({
  args: connectionArgs,
  returns: catalogConnectionView,
  handler: async (ctx, { connectionId }) => {
    const row = await requireCatalogConnection(ctx, connectionId);
    return {
      accountId: row.accountId,
      connectedAt: row.connectedAt,
    };
  },
});

export const readCatalogMappings = internalQuery({
  args: catalogMappingArgs,
  returns: v.array(mappingView),
  handler: async (ctx, { connectionId, connectedAt, productIds, variantIds }) => {
    const row = await requireCatalogConnection(ctx, connectionId);
    if (row.connectedAt !== connectedAt) {
      throw expectedError("whop.connection_changed", "The Whop connection changed. Load the catalog again.");
    }
    const mappings = await Promise.all([
      ...productIds.slice(0, pageSize).map((id) => latestMapping(ctx, row.tenantId, row._id, "product_program", id)),
      ...variantIds.slice(0, pageSize).map((id) => latestMapping(ctx, row.tenantId, row._id, "variant_type", id)),
    ]);
    return mappings.flatMap((row) => {
      const mapping = toActiveMapping(row);
      return mapping ? [mapping] : [];
    });
  },
});

const account = z.object({ id: z.string() }).nullable();
const product = z.object({
  id: z.string().refine((id) => validExternalId("product_program", id)),
  title: z.string(),
  visibility: z.string().nullable(),
  account,
});
const variant = z.object({
  id: z.string().refine((id) => validExternalId("variant_type", id)),
  product: z.object({
    id: z.string().refine((id) => validExternalId("product_program", id)),
    title: z.string(),
  }).nullable(),
  title: z.string().nullable(),
  visibility: z.string(),
  billing_type: z.string(),
  currency: z.string(),
  initial_price: z.number(),
  renewal_price: z.number(),
  billing_period: z.number().nullable(),
  split_pay_required_payments: z.number().nullable(),
  account,
});

const nullableString = v.union(v.string(), v.null());
const nullableNumber = v.union(v.number(), v.null());
const catalogView = v.object({
  products: v.array(v.object({
    productId: v.string(),
    title: v.string(),
    visibility: nullableString,
    binding: v.union(v.null(), productMapping),
  })),
  variants: v.array(v.object({
    variantId: v.string(),
    productId: nullableString,
    productTitle: nullableString,
    title: nullableString,
    visibility: v.string(),
    billingType: v.string(),
    currency: v.string(),
    initialPrice: v.number(),
    renewalPrice: v.number(),
    billingPeriodDays: nullableNumber,
    splitPayRequiredPayments: nullableNumber,
    binding: v.union(v.null(), variantMapping),
  })),
  nextProductCursor: nullableString,
  nextVariantCursor: nullableString,
});

async function loadCatalogPage<T extends { account: { id: string } | null }>(
  ctx: ActionCtx,
  connectionId: ConnectionId,
  connection: Infer<typeof catalogConnectionView>,
  path: "/products" | "/variants",
  cursor: string | null | undefined,
  item: z.ZodType<T>,
): Promise<{ items: T[]; nextCursor: string | null }> {
  if (cursor === null) return { items: [], nextCursor: null };
  const pageSchema = z.object({
    data: z.array(item).max(pageSize),
    page_info: z.object({
      has_next_page: z.boolean(),
      end_cursor: z.string().min(1).max(cursorLimit).nullable(),
    }),
  });
  try {
    return await whopFetch(ctx, connectionId, path, {
      connectedAt: connection.connectedAt,
      query: { account_id: connection.accountId, first: pageSize, after: cursor },
    }, (response) => {
      const parsed = pageSchema.safeParse(response);
      if (!parsed.success) throw new WhopRequestError("unexpected_response");
      const { data, page_info: info } = parsed.data;
      if (data.some((entry) => entry.account && entry.account.id !== connection.accountId)) {
        throw new WhopAccountMismatch();
      }
      if (info.has_next_page && (!info.end_cursor || info.end_cursor === cursor)) {
        throw new WhopRequestError("unexpected_response");
      }
      return { items: data, nextCursor: info.has_next_page ? info.end_cursor : null };
    });
  } catch (error) {
    throw rejectWhopRequest(error instanceof WhopAccountMismatch ? "account_mismatch" : whopRequestFailure(error));
  }
}

export const listCatalog = action({
  args: {
    ...connectionArgs,
    productCursor: v.optional(nullableString),
    variantCursor: v.optional(nullableString),
  },
  returns: catalogView,
  handler: async (ctx, { connectionId, productCursor, variantCursor }): Promise<Infer<typeof catalogView>> => {
    await requireTenantUserFromAction(ctx, settingsRoles);
    if ([productCursor, variantCursor].some((cursor) => cursor != null && (!cursor.length || cursor.length > cursorLimit))) {
      throw rejectRequest("whop.invalid_cursor", "Invalid Whop catalog cursor.");
    }
    const connection = await ctx.runQuery(internal.payments.bindings.readCatalogConnection, { connectionId });
    const products = await loadCatalogPage(ctx, connectionId, connection, "/products", productCursor, product);
    const variants = await loadCatalogPage(ctx, connectionId, connection, "/variants", variantCursor, variant);
    const mappings = await ctx.runQuery(internal.payments.bindings.readCatalogMappings, {
      connectionId,
      connectedAt: connection.connectedAt,
      productIds: products.items.map((row) => row.id),
      variantIds: variants.items.map((row) => row.id),
    });
    const byExternalId = new Map(mappings.map((row) => [row.externalId, row]));
    return {
      products: products.items.map((row) => {
        const binding = byExternalId.get(row.id);
        return {
          productId: row.id,
          title: row.title.slice(0, 512),
          visibility: row.visibility,
          binding: binding?.kind === "product_program" ? binding : null,
        };
      }),
      variants: variants.items.map((row) => {
        const binding = byExternalId.get(row.id);
        return {
          variantId: row.id,
          productId: row.product?.id ?? null,
          productTitle: row.product?.title.slice(0, 512) ?? null,
          title: row.title?.slice(0, 512) ?? null,
          visibility: row.visibility,
          billingType: row.billing_type,
          currency: row.currency,
          initialPrice: row.initial_price,
          renewalPrice: row.renewal_price,
          billingPeriodDays: row.billing_period,
          splitPayRequiredPayments: row.split_pay_required_payments,
          binding: binding?.kind === "variant_type" ? binding : null,
        };
      }),
      nextProductCursor: products.nextCursor,
      nextVariantCursor: variants.nextCursor,
    };
  },
});
