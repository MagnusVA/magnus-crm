import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_NOW, PRODUCT_ID, providerPaymentFixture } from "../../tests/providerPaymentFixtures";
import { api } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import schema from "../schema";
import { convexTestModules } from "../test.setup";
import { refreshProviderPaymentReview } from "./match";
import { WHOP_API_VERSION_DATE } from "./whop/client";

const bindings = api.payments.bindings;
const accountId = "biz_TestCatalog";
const apiKey = "test_catalog_key_0000";
const productId = "prod_TestProduct";
const variantId = "plan_TestVariant";
const now = Date.parse("2026-11-17T15:00:00Z");

vi.mock("./match", async (importOriginal) => {
  const match = await importOriginal<typeof import("./match")>();
  return { ...match, refreshProviderPaymentReview: vi.fn(match.refreshProviderPaymentReview) };
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubEnv("WORKOS_CLIENT_ID", "client_test");
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function addTenant(ctx: MutationCtx, name: string) {
  const tenantId = await ctx.db.insert("tenants", {
    companyName: name,
    contactEmail: `${name}@example.com`,
    workosOrgId: `org_${name}`,
    status: "active",
    inviteExpiresAt: 0,
    createdBy: "test",
  });
  const adminId = await ctx.db.insert("users", {
    tenantId,
    workosUserId: `user_${name}`,
    email: `${name}@example.com`,
    role: "tenant_admin",
    isActive: true,
  });
  const connectionId = await ctx.db.insert("tenantPaymentConnections", {
    tenantId,
    accountId,
    provider: "whop",
    environment: "live",
    credentialKind: "account_key",
    apiKey,
    keyLast4: "0000",
    apiVersionDate: WHOP_API_VERSION_DATE,
    status: "connected",
    connectedByUserId: adminId,
    connectedAt: now,
    autoImportAfter: now,
  });
  const programId = await ctx.db.insert("tenantPrograms", {
    tenantId,
    name: "Test program",
    normalizedName: "test program",
    createdByUserId: adminId,
    createdAt: now,
    updatedAt: now,
  });
  return { tenantId, adminId, connectionId, programId };
}

async function fixture() {
  const t = convexTest({ schema, modules: convexTestModules });
  const { primary, other } = await t.run(async (ctx) => {
    const primary = await addTenant(ctx, "test");
    const other = await addTenant(ctx, "other");
    await ctx.db.insert("users", {
      tenantId: primary.tenantId,
      workosUserId: "user_closer",
      email: "closer@example.com",
      role: "closer",
      isActive: true,
    });
    return { primary, other };
  });
  return {
    t, primary, other,
    admin: t.withIdentity({ subject: "user_test", org_id: "org_test" }),
    closer: t.withIdentity({ subject: "user_closer", org_id: "org_test" }),
    foreignAdmin: t.withIdentity({ subject: "user_other", org_id: "org_other" }),
  };
}

describe("Whop mapping versions", () => {
  it("replaces mappings atomically, keeps removed versions, and starts after the newest version", async () => {
    const { t, admin, primary } = await fixture();
    const args = { connectionId: primary.connectionId, programId: primary.programId, productId };
    const first = await admin.mutation(bindings.setProductProgram, { ...args, externalTitle: "Product display name" });
    let current = first;
    for (let version = 2; version <= 10; version++) {
      current = await admin.mutation(bindings.setProductProgram, args);
    }
    const listArgs = { connectionId: primary.connectionId, kind: "product_program" } as const;
    expect(await admin.query(bindings.listBindings, listArgs)).toEqual({
      bindings: [{
        bindingId: current, kind: "product_program", externalId: productId,
        externalTitle: "Product display name", programId: primary.programId,
        version: 10, setByUserId: primary.adminId, setAt: now,
      }],
      nextCursor: null,
    });
    expect(await t.run((ctx) => ctx.db.get("paymentProviderBindings", first)))
      .toMatchObject({ version: 1, enabled: false, disabledReason: "removed" });
    await admin.mutation(bindings.removeBinding, { bindingId: first });
    expect(await admin.query(bindings.listBindings, listArgs))
      .toMatchObject({ bindings: [{ bindingId: current }] });
    await admin.mutation(bindings.removeBinding, { bindingId: current });
    expect(await admin.query(bindings.listBindings, listArgs)).toEqual({ bindings: [], nextCursor: null });
    const restored = await admin.mutation(bindings.setProductProgram, args);
    expect(await admin.query(bindings.listBindings, listArgs))
      .toMatchObject({ bindings: [{ bindingId: restored, version: 11 }] });
    expect(await t.run((ctx) => ctx.db.get("paymentProviderBindings", current)))
      .toMatchObject({ version: 10, enabled: false, disabledReason: "removed" });
  });

  it("pages by external ID and keeps product and variant lists separate", async () => {
    const { t, admin, primary } = await fixture();
    await t.run(async (ctx) => {
      for (let i = 1; i <= 52; i++) {
        await ctx.db.insert("paymentProviderBindings", {
          tenantId: primary.tenantId,
          connectionId: primary.connectionId,
          externalId: `prod_${String(i).padStart(2, "0")}`,
          kind: "product_program",
          binding: { kind: "product_program", programId: primary.programId },
          version: 1,
          enabled: i !== 50,
          setAt: now,
          setByUserId: primary.adminId,
        });
      }
    });
    await admin.mutation(bindings.setVariantType, {
      connectionId: primary.connectionId, variantId, paymentType: "deposit", laterPaymentType: "split",
    });
    const args = { connectionId: primary.connectionId, kind: "product_program" } as const;
    const first = await admin.query(bindings.listBindings, args);
    expect(first.bindings).toHaveLength(49);
    expect(first.nextCursor).toBe("prod_50");
    if (!first.nextCursor) throw new Error("Expected more mappings");
    const second = await admin.query(bindings.listBindings, { ...args, cursor: first.nextCursor });
    expect(second.bindings.map((row) => row.externalId)).toEqual(["prod_51", "prod_52"]);
    expect(second.nextCursor).toBeNull();
    expect(await admin.query(bindings.listBindings, { ...args, kind: "variant_type" }))
      .toMatchObject({
        bindings: [{ externalId: variantId, paymentType: "deposit", laterPaymentType: "split" }],
        nextCursor: null,
      });
  });

  it("rejects closer access, cross-tenant connections, bindings and programs", async () => {
    const f = await fixture();
    const { connectionId, programId } = f.primary;
    const moveProduct = { connectionId, productId, programId };
    const moveVariant = { connectionId, variantId, paymentType: "monthly" } as const;
    const read = { connectionId, kind: "product_program" } as const;
    const bindingId = await f.admin.mutation(bindings.setProductProgram, moveProduct);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const denied = { data: { code: "auth.insufficient_permissions" } };
    await expect(f.closer.query(bindings.listBindings, read)).rejects.toMatchObject(denied);
    await expect(f.closer.action(bindings.listCatalog, { connectionId })).rejects.toMatchObject(denied);
    await expect(f.closer.mutation(bindings.setProductProgram, moveProduct)).rejects.toMatchObject(denied);
    await expect(f.closer.mutation(bindings.setVariantType, moveVariant)).rejects.toMatchObject(denied);
    await expect(f.closer.mutation(bindings.removeBinding, { bindingId })).rejects.toMatchObject(denied);
    const foreign = { data: { code: "whop.connection_not_found" } };
    await expect(f.foreignAdmin.query(bindings.listBindings, read)).rejects.toMatchObject(foreign);
    await expect(f.foreignAdmin.action(bindings.listCatalog, { connectionId })).rejects.toMatchObject(foreign);
    await expect(f.foreignAdmin.mutation(bindings.setProductProgram, moveProduct)).rejects.toMatchObject(foreign);
    await expect(f.foreignAdmin.mutation(bindings.setVariantType, moveVariant)).rejects.toMatchObject(foreign);
    await expect(f.foreignAdmin.mutation(bindings.removeBinding, { bindingId }))
      .rejects.toMatchObject({ data: { code: "whop.binding_not_found" } });
    await expect(f.admin.mutation(bindings.setProductProgram, { ...moveProduct, programId: f.other.programId }))
      .rejects.toMatchObject({ data: { code: "whop.program_not_found" } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await f.foreignAdmin.query(bindings.listBindings, { ...read, connectionId: f.other.connectionId }))
      .toEqual({ bindings: [], nextCursor: null });
    expect(await f.admin.query(bindings.listBindings, read))
      .toMatchObject({ bindings: [{ bindingId, programId }] });
  });
});

describe("Whop catalog", () => {
  const product = { id: productId, title: "Product title", visibility: "hidden", account: { id: accountId } };
  const variant = {
    id: variantId,
    title: null,
    account: { id: accountId },
    product: { id: productId, title: product.title },
    billing_type: "renewal",
    visibility: "hidden",
    currency: "usd",
    initial_price: 25,
    renewal_price: 100,
    billing_period: 30,
    split_pay_required_payments: 4,
  };

  it("merges current mappings and pages products and variants independently", async () => {
    const { admin, primary } = await fixture();
    const { connectionId, programId } = primary;
    const productBinding = await admin.mutation(bindings.setProductProgram, { connectionId, productId, programId });
    await admin.mutation(bindings.setVariantType, { connectionId, variantId, paymentType: "pif" });
    const variantBinding = await admin.mutation(bindings.setVariantType, {
      connectionId, variantId, paymentType: "deposit", laterPaymentType: "split",
    });
    const fetchMock = vi.fn(async (url: string, _init: RequestInit) => {
      // Time spent on the request can cover the shared request-clock interval.
      vi.setSystemTime(Date.now() + 200);
      const request = new URL(url);
      if (request.pathname === "/api/v1/products") {
        return Response.json({ data: [product], page_info: { has_next_page: false, end_cursor: "product-end" } });
      }
      if (request.pathname === "/api/v1/variants") {
        if (request.searchParams.get("after") === "price-next") {
          return Response.json({
            data: [{ ...variant, id: "plan_Standalone", product: null, billing_period: null }],
            page_info: { has_next_page: false, end_cursor: "price-end" },
          });
        }
        return Response.json({ data: [variant], page_info: { has_next_page: true, end_cursor: "price-next" } });
      }
      throw new Error("Unexpected test request");
    });
    vi.stubGlobal("fetch", fetchMock);
    const page = await admin.action(bindings.listCatalog, { connectionId });
    expect(page).toMatchObject({
      products: [{
        productId, title: product.title, visibility: "hidden",
        binding: { bindingId: productBinding, programId, version: 1 },
      }],
      variants: [{
        variantId, productId, productTitle: product.title, title: null, currency: "usd",
        billingType: "renewal", initialPrice: 25, renewalPrice: 100,
        billingPeriodDays: 30, splitPayRequiredPayments: 4,
        binding: { bindingId: variantBinding, paymentType: "deposit", laterPaymentType: "split", version: 2 },
      }],
      nextProductCursor: null,
      nextVariantCursor: "price-next",
    });
    expect(JSON.stringify(page)).not.toContain(apiKey);
    const nextPage = await admin.action(bindings.listCatalog, {
      connectionId, productCursor: page.nextProductCursor, variantCursor: page.nextVariantCursor,
    });
    expect(nextPage).toMatchObject({
      products: [],
      variants: [{ variantId: "plan_Standalone", productId: null, productTitle: null, binding: null }],
      nextProductCursor: null, nextVariantCursor: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `https://api.whop.com/api/v1/products?account_id=${accountId}&first=50`,
      `https://api.whop.com/api/v1/variants?account_id=${accountId}&first=50`,
      `https://api.whop.com/api/v1/variants?account_id=${accountId}&first=50&after=price-next`,
    ]);
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      Authorization: `Bearer ${apiKey}`, "Api-Version-Date": WHOP_API_VERSION_DATE,
    });
  });

  it("rejects a page for a different Whop account", async () => {
    const { admin, primary } = await fixture();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      data: [{ ...product, account: { id: "biz_NotOurs" } }],
      page_info: { has_next_page: false, end_cursor: null },
    })));
    await expect(admin.action(bindings.listCatalog, { connectionId: primary.connectionId, variantCursor: null }))
      .rejects.toMatchObject({ data: { code: "whop.account_mismatch" } });
  });
});

describe("Whop mapping refresh", () => {
  it("reclassifies a payment using the current mapping when older versions exist", async () => {
    vi.setSystemTime(FIXTURE_NOW);
    const f = await providerPaymentFixture({
      fact: { variantId, reviewState: "needs_person", reviewReason: "unmapped_product" },
    });
    await f.admin.mutation(bindings.setProductProgram, {
      connectionId: f.connectionId, productId: PRODUCT_ID, programId: f.programId,
    });
    const bindingId = await f.admin.mutation(bindings.setVariantType, {
      connectionId: f.connectionId, variantId, paymentType: "pif",
    });
    const read = () => f.t.run((ctx) => ctx.db.get("providerPayments", f.providerPaymentId));
    await f.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await read()).toMatchObject({
      reviewState: "needs_person", reviewReason: "ready", candidateOpportunityId: f.dealId,
    });

    await f.admin.mutation(bindings.removeBinding, { bindingId });
    await f.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await read()).toMatchObject({ reviewState: "needs_person", reviewReason: "unmapped_product" });
  });

  it("refreshes only unresolved matching payments and continues past a full page", async () => {
    const { t, admin, primary, other } = await fixture();
    const { connectionId, tenantId, programId } = primary;
    const paymentIds = await t.run(async (ctx) => {
      const base = {
        tenantId, connectionId, productId, variantId,
        status: "paid", reviewState: "needs_person",
        sourceUpdatedAt: now, sourceCreatedAt: now, refreshGeneration: 1, firstSeenAt: now,
        currency: "usd", decimals: 2, totalMinor: 100, refundedMinor: 0,
        adverseState: "none", lineItemCount: 1, failedAttemptCount: 0,
      } as const satisfies Omit<Doc<"providerPayments">, "_id" | "_creationTime" | "externalPaymentId">;
      const matching = [];
      for (let i = 0; i < 55; i++) {
        matching.push(await ctx.db.insert("providerPayments", {
          ...base, externalPaymentId: `pay_Matching_${String(i).padStart(2, "0")}`,
        }));
      }
      await ctx.db.insert("providerPayments", { ...base, externalPaymentId: "pay_Different", productId: "prod_Different" });
      await ctx.db.insert("providerPayments", { ...base, externalPaymentId: "pay_Resolved", reviewState: "dismissed" });
      await ctx.db.insert("providerPayments", {
        ...base, externalPaymentId: "pay_Other", connectionId: other.connectionId, tenantId: other.tenantId,
      });
      return matching;
    });
    const bindingId = await admin.mutation(bindings.setProductProgram, { connectionId, programId, productId });
    const refresh = vi.mocked(refreshProviderPaymentReview);
    expect(refresh).not.toHaveBeenCalled();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(refresh.mock.calls.map(([, id]) => id)).toEqual(paymentIds);
    expect(await t.run((ctx) => ctx.db.system.query("_scheduled_functions").take(10)))
      .toHaveLength(6);

    refresh.mockClear();
    await admin.mutation(bindings.removeBinding, { bindingId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(refresh.mock.calls.map(([, id]) => id)).toEqual(paymentIds);
  });
});
