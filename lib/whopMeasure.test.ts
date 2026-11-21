// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { compareAmount, HARD_CASES, measure, rolloutDecisions } from "../scripts/whop-measure/aggregate.mjs";
import { buildCrm, dealAt, matchIdentity } from "../scripts/whop-measure/crm.mjs";
import { assessPayment, buildMembershipIndex, identifyPayments } from "../scripts/whop-measure/match.mjs";
import { exactMinorUnits, normalizePayment, usableEmail, usablePhone } from "../scripts/whop-measure/normalize.mjs";
import { API_VERSION_DATE, compareScans, replayScan, retryAfterMs, scanPayments, whopPageReader } from "../scripts/whop-measure/paging.mjs";
import { renderReport } from "../scripts/whop-measure/report.mjs";

const account = "biz_ExampleAb12";
const tenantId = "tenant_synthetic";
const email = "synthetic-payer@example.com";
const phone = "+17789559253";
const otherPhone = "+14153019876";
const created = "2026-11-10T08:00:00.000Z";
const paidAt = "2026-11-10T09:00:00.000Z";
const asOf = Date.parse("2026-11-11T10:00:00.000Z");
const window = { from: Date.parse("2026-11-10"), to: Date.parse("2026-11-11") };
const scanOptions = { account, window };
const noSleep = vi.fn<(milliseconds: number) => Promise<void>>().mockResolvedValue(undefined);

type Row = Record<string, unknown>;
type Table = Row[];

function payment(id: string, fields: Row = {}) {
  return {
    id, account_id: account, created_at: created, updated_at: paidAt, paid_at: paidAt,
    status: "paid", currency: "usd", total: { amount: "100.00", currency: "usd", decimals: 2 },
    product_id: "prod_synthetic", variant_id: "plan_synthetic", billing_reason: "one_time",
    line_items: [{ product_title: "Synthetic Fixture Name" }], payment_method_type: "card",
    customer_email: email, ...fields,
  };
}

function page(data: Row[], endCursor?: string) {
  return { data, page_info: { has_next_page: endCursor !== undefined, end_cursor: endCursor ?? null } };
}

function lead(_id: string, fields: Row = {}) {
  return { _id, tenantId, status: "active", ...fields };
}

function deal(_id: string, leadId: string, fields: Row = {}) {
  return {
    _id, tenantId, leadId, outcome: "open", stage: "booked", createdAt: window.from,
    assignedCloserId: "closer_synthetic", ...fields,
  };
}

function identifier(leadId: string, type: string, value: string, confidence = "verified") {
  return { tenantId, leadId, type, value, confidence };
}

function tables(overrides: Record<string, Table> = {}) {
  return {
    leads: [], leadIdentifiers: [], opportunities: [], paymentRecords: [],
    leadMergeHistory: [], meetings: [], ...overrides,
  };
}

function providerTables(overrides: Record<string, Table> = {}) {
  const connectionId = "connection_synthetic";
  return {
    tenantPaymentConnections: [{
      _id: connectionId, tenantId, provider: "whop", accountId: account, environment: "live", autoImportAfter: window.from,
    }],
    tenantPrograms: [{ _id: "program_synthetic", tenantId }],
    providerPayments: [],
    paymentProviderBindings: [
      {
        tenantId, connectionId, kind: "product_program", externalId: "prod_synthetic", enabled: true, version: 1,
        binding: { kind: "product_program", programId: "program_synthetic" },
      },
      {
        tenantId, connectionId, kind: "variant_type", externalId: "plan_synthetic", enabled: true, version: 1,
        binding: { kind: "variant_type", paymentType: "deposit" },
      },
    ],
    ...overrides,
  };
}

describe("Whop scan", () => {
  it("pages through the last cursor with fixed all-status account filters", async () => {
    const read = vi.fn().mockResolvedValueOnce(page([payment("pay_first")], "cursor-1"))
      .mockResolvedValueOnce(page([payment("pay_second", { status: "open" })], "cursor-2"))
      .mockResolvedValueOnce(page([payment("pay_third")]));
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>().mockResolvedValue(undefined);
    const result = await scanPayments(read, { ...scanOptions, sleep });

    expect([...result.payments.keys()]).toEqual(["pay_first", "pay_second", "pay_third"]);
    expect(read.mock.calls[0][0]).toEqual({
      account_id: account,
      mode: "account_sales",
      created_after: "2026-11-09T23:59:59.999Z",
      created_before: "2026-11-11T00:00:00.000Z",
      order: "created_at",
      direction: "desc",
      first: 100,
    });
    expect(read.mock.calls.slice(1).map(([query]) => query.after)).toEqual(["cursor-1", "cursor-2"]);
    expect(sleep.mock.calls).toEqual([[250], [250]]);
  });

  it("sends GET with the pinned version and retries a 429 after Retry-After", async () => {
    const fetchPage = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("private provider error", { status: 429, headers: { "Retry-After": "2" } }))
      .mockResolvedValueOnce(Response.json(page([])));
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>().mockResolvedValue(undefined);
    const read = whopPageReader({ apiKey: "synthetic", sandbox: true, fetchPage, sleep });

    expect(await read({ account_id: account, mode: "account_sales" })).toEqual(page([]));
    expect(sleep).toHaveBeenCalledExactlyOnceWith(2000);
    const [url, init] = fetchPage.mock.calls[0];
    expect(String(url)).toBe(`https://sandbox-api.whop.com/api/v1/payments?account_id=${account}&mode=account_sales`);
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("Api-Version-Date")).toBe(API_VERSION_DATE);
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer synthetic");
    expect(retryAfterMs("Wed, 18 Nov 2026 05:00:05 GMT", Date.parse("2026-11-18T05:00:00Z"))).toBe(5000);
  });

  it("uses event bounds even for older charges", async () => {
    const read = vi.fn().mockResolvedValue(page([
      payment("pay_old", { created_at: "2026-10-01T00:00:00Z" }),
    ]));
    const result = await scanPayments(read, { ...scanOptions, filter: "dispute_created", sleep: noSleep });
    expect(result.payments.size).toBe(1);
    expect(read.mock.calls[0][0]).toMatchObject({ dispute_created_before: "2026-11-11T00:00:00.000Z" });
    expect(read.mock.calls[0][0]).not.toHaveProperty("created_before");
  });

  it("counts presence and amount differences once and excludes out-of-scope rows", async () => {
    const first = await replayScan([page([
      payment("pay_first_only"),
      payment("pay_amount"),
      payment("pay_equivalent"),
      payment("pay_wrong_account", { account_id: "biz_SomeoneElse" }),
    ])], scanOptions);
    const second = await replayScan([page([
      payment("pay_second_only"),
      payment("pay_amount", { total: { amount: "0.10", currency: "usd", decimals: 2 } }),
      payment("pay_equivalent", { total: { amount: "100.000", currency: "usd", decimals: 3 }, status: "open" }),
      payment("pay_outside", { created_at: "2026-11-11T00:00:00.000Z" }),
    ])], scanOptions);

    expect(compareScans(first.payments, second.payments)).toEqual({
      unique: 4, shared: 2, different: 3, firstOnly: 1, secondOnly: 1, amountChanged: 1, statusChanged: 1,
    });
    expect(first.wrongAccount).toBe(1);
    expect(second.outsideFilter).toBe(1);
  });

  it("rejects a repeated cursor", async () => {
    const read = vi.fn().mockResolvedValue(page([], "same"));
    await expect(scanPayments(read, { ...scanOptions, sleep: noSleep })).rejects.toThrow("repeated payment cursor");
  });
});

describe("amount and identity normalization", () => {
  it.each([
    ["2437.50", 2, 243750n], ["0.10", 2, 10n], ["1000", 2, 100000n],
    ["1000", 0, 1000n], ["2437.507", 3, 2437507n], ["7.000", 0, 7n],
    ["0.001", 2, undefined], ["1e3", 2, undefined],
  ])("converts %s exactly with %s decimals", (amount, decimals, expected) => {
    expect(exactMinorUnits(amount, decimals)).toBe(expected);
  });

  it("uses Whop's precision for zero- and three-decimal currencies", () => {
    const yen = normalizePayment(payment("pay_yen", { total: { amount: "1000", currency: "jpy", decimals: 0 } }));
    const dinar = normalizePayment(payment("pay_dinar", { total: { amount: "4.307", currency: "kwd", decimals: 3 } }));
    expect(yen.total).toEqual({ currency: "JPY", decimals: 0, minor: 1000n });
    expect(dinar.total).toEqual({ currency: "KWD", decimals: 3, minor: 4307n });
  });

  it("preserves tags and dots and rejects placeholder addresses and phones", () => {
    expect(usableEmail(" P.Ayer+tag@EXAMPLE.COM ")).toBe("p.ayer+tag@example.com");
    for (const value of ["email@gmail.com", "email@example.com", "buyer@notanemail.com", "bad", ""]) {
      expect(usableEmail(value)).toBeUndefined();
    }
    expect(usablePhone(" +1 (778) 955-9253 ")).toBe(phone);
    for (const value of ["7789559253", "+1 234-234-2341", "+1 812-345-6780", "+1 212-345-6789"]) {
      expect(usablePhone(value)).toBeUndefined();
    }
  });

  it("resolves merge history and pointers, counting all identities after deduplication", () => {
    const crm = buildCrm(tables({
      leads: [
        lead("one", { status: "merged", email }),
        lead("two", { status: "merged", mergedIntoLeadId: "three" }),
        lead("three", { email }),
        lead("cycle", { status: "merged", mergedIntoLeadId: "cycle", email: "cycle@example.com" }),
      ],
      leadMergeHistory: [{ tenantId, sourceLeadId: "one", targetLeadId: "two" }],
      leadIdentifiers: [identifier("two", "email", email)],
    }), { account });

    expect(crm.survivor("one")).toBe("three");
    expect(matchIdentity(crm, { email })).toMatchObject({ bucket: "email", exactEmail: "three" });
    expect(matchIdentity(crm, { email: "cycle@example.com" })).toMatchObject({
      bucket: "conflicting", reason: "ambiguous_person",
    });
  });

  it("distinguishes all matching buckets without guessed or suggested identifiers", () => {
    const crm = buildCrm(tables({
      leads: [
        lead("one", { email }), lead("two"), lead("three", { email: "email@example.com" }),
        lead("four", { email: "shared@example.com" }), lead("five", { email: "shared@example.com" }),
      ],
      leadIdentifiers: [
        identifier("one", "phone", phone), identifier("two", "phone", otherPhone),
        identifier("one", "email", "suggested@example.com", "suggested"),
      ],
    }), { account });

    for (const [payer, expected] of [
      [{ email, phone }, "email"],
      [{ email: "absent@example.com", phone }, "phoneOnly"],
      [{ email, phone: otherPhone }, "conflicting"],
      [{ email: "shared@example.com", phone }, "conflicting"],
      [{ email: "suggested@example.com" }, "unknown"],
      [{ email: usableEmail("Email@Example.com") }, "noEmail"],
    ] as const) {
      expect(matchIdentity(crm, payer).bucket).toBe(expected);
    }
    expect(matchIdentity(crm, { email, phone: otherPhone }).exactEmail).toBe("one");
  });
});

describe("deal rules and comparisons", () => {
  it("uses the full rule when config is available and holds for manual money", () => {
    const raw = normalizePayment(payment("pay_ready"));
    const input = tables({
      ...providerTables(),
      leads: [lead("one", { email })],
      opportunities: [deal("one_deal", "one")],
    });
    const crm = buildCrm(input, { account });
    const identity = matchIdentity(crm, raw);
    const memberships = buildMembershipIndex(crm, [raw], identifyPayments(crm, [raw]));
    expect(assessPayment(crm, raw, identity, memberships, asOf)).toMatchObject({ kind: "ready", person: "one" });
    const withManual = buildCrm({
      ...input, paymentRecords: [{ _id: "one_record", tenantId, opportunityId: "one_deal", status: "recorded" }],
    }, { account });
    expect(assessPayment(withManual, raw, identity, memberships, asOf)).toMatchObject({
      kind: "needs_person", reason: "unlinked_manual_payment",
    });
  });

  it("tests capacity at 39 and 40 stored rows, including disputed records", () => {
    const raw = normalizePayment(payment("pay_capacity"));
    for (const [length, kind] of [[39, "ready"], [40, "needs_person"]] as const) {
      const crm = buildCrm(tables({
        ...providerTables(),
        leads: [lead("one", { email })],
        opportunities: [deal("one_deal", "one")],
        paymentRecords: Array.from({ length }, (_, index) => ({
          _id: `old_${index}`, tenantId, opportunityId: "one_deal", status: "disputed",
        })),
      }), { account });
      const identity = matchIdentity(crm, raw);
      const index = buildMembershipIndex(crm, [raw], identifyPayments(crm, [raw]));
      const target = assessPayment(crm, raw, identity, index, asOf);
      expect(target.kind).toBe(kind);
      if (kind === "needs_person") expect(target).toMatchObject({ reason: "capacity_hold" });
    }
  });

  it("uses an active allocation first and a trusted membership ahead of checkout for a renewal", () => {
    const base = providerTables();
    const crm = buildCrm(tables({
      ...base,
      leads: [lead("buyer"), lead("other", { email })],
      opportunities: [
        deal("membership_deal", "buyer", { outcome: "won", stage: "closed" }),
        deal("checkout_deal", "other"),
      ],
      paymentRecords: [{
        _id: "anchor", tenantId, opportunityId: "membership_deal", status: "verified",
        providerPaymentId: "stored", programId: "program_synthetic",
      }],
      providerPayments: [{
        _id: "stored", tenantId, connectionId: "connection_synthetic", externalPaymentId: "pay_anchor",
        membershipId: "mem_synthetic", opportunityId: "membership_deal", paymentRecordId: "anchor",
        leadId: "buyer", status: "paid",
      }],
      paymentProviderBindings: [
        ...base.paymentProviderBindings,
        {
          tenantId, connectionId: "connection_synthetic", kind: "membership_deal", externalId: "mem_synthetic",
          version: 1, enabled: true,
          binding: { kind: "membership_deal", opportunityId: "membership_deal", leadId: "buyer", anchorPaymentRecordId: "anchor" },
        },
        {
          tenantId, connectionId: "connection_synthetic", kind: "checkout_deal", externalId: "ch_synthetic",
          version: 1, enabled: true, binding: { kind: "checkout_deal", opportunityId: "checkout_deal", leadId: "other" },
        },
      ],
    }), { account });

    const renewal = normalizePayment(payment("pay_renewal", {
      membership_id: "mem_synthetic", checkout_configuration_id: "ch_synthetic", billing_reason: "subscription_cycle",
    }));
    const anchor = normalizePayment(payment("pay_anchor", { checkout_configuration_id: "ch_synthetic" }));
    const observed = [renewal, anchor];
    const ids = identifyPayments(crm, observed);
    const index = buildMembershipIndex(crm, observed, ids);
    expect(assessPayment(crm, renewal, ids.get(renewal.id), index, asOf)).toMatchObject({ kind: "ready", person: "buyer" });
    expect(assessPayment(crm, anchor, ids.get(anchor.id), index, asOf)).toMatchObject({ kind: "resolved", person: "buyer" });
  });

  it("reconstructs the open stage at collection from a later close", () => {
    const opportunity = deal("one_deal", "one", {
      outcome: "won", stage: "closed", paymentReceivedAt: Date.parse(paidAt) + 1000,
    });
    const crm = buildCrm(tables({
      leads: [lead("one", { email })],
      opportunities: [opportunity],
      domainEvents: [{
        tenantId, entityType: "opportunity", entityId: "one_deal", eventType: "opportunity.stage_changed",
        occurredAt: Date.parse(paidAt) + 1000, fromStatus: "follow_up", toStatus: "closed",
        metadata: JSON.stringify({ fromOutcome: "open", toOutcome: "won" }),
      }],
    }), { account });

    expect(dealAt(crm, opportunity, Date.parse(paidAt))).toEqual({
      stage: "follow_up", outcome: "open", fromHistory: true,
    });
  });

  it.each([
    [10000, "USD", "equal"],
    [10299, "USD", "underThree"],
    [9700, "USD", "threeOrMore"],
    [10301, "USD", "threeOrMore"],
    [10000, "CAD", "differentCurrency"],
    [NaN, "USD", "unavailable"],
  ])("compares stored amount %s %s against the Whop total", (amountMinor, currency, bucket) => {
    const total = normalizePayment(payment("pay_amount")).total;
    expect(compareAmount(total, { amountMinor, currency })).toBe(bucket);
  });

  it("evaluates rollout thresholds without rounding", () => {
    expect(rolloutDecisions(849, 1000, 39)).toEqual({ belowIdentityTarget: true, atCapacity: false });
    expect(rolloutDecisions(850, 1000, 40)).toEqual({ belowIdentityTarget: false, atCapacity: true });
  });
});

describe("report and CLI", () => {
  it("reports aggregate coverage, with a separate sample covering hard cases", async () => {
    const known = Array.from({ length: 65 }, (_, index) => payment(`pay_known_${index}`));
    const hard = [
      payment("pay_unknown", { customer_email: "other-payer@example.com", product_id: "Synthetic Fixture Name" }),
      payment("pay_multi", { customer_email: "multi@example.com" }),
      payment("pay_renewal", { billing_reason: "subscription_cycle", membership_id: "mem_repeat" }),
      payment("pay_financing", {
        payment_method_type: "klarna", financing_installments_count: 12,
        membership_id: "mem_repeat",
      }),
      payment("pay_refund", { substatus: "refunded" }),
      payment("pay_dispute", { substatus: "dispute_under_review", payment_method_type: "pay_by_bank" }),
      payment("pay_mismatch", {
        customer_email: "mismatch@example.com", total: { amount: "97.00", currency: "usd", decimals: 2 },
        payment_method_type: "Synthetic Fixture Name",
      }),
    ];
    const scan = await replayScan([page([...known, ...hard])], scanOptions);
    const refunds = await replayScan([page([hard[4]])], { ...scanOptions, filter: "refunded" });
    const disputes = await replayScan([page([hard[5]])], { ...scanOptions, filter: "dispute_created" });
    const crm = buildCrm(tables({
      leads: [
        lead("person_known", { email, fullName: "Synthetic Fixture Name" }),
        lead("person_multi", { email: "multi@example.com" }),
        lead("person_mismatch", { email: "mismatch@example.com" }),
        lead("person_crm_only", { email: "crm-only@example.com" }),
      ],
      opportunities: [
        deal("deal_known", "person_known"), deal("deal_multi_1", "person_multi"),
        deal("deal_multi_2", "person_multi", { stage: "qualified" }), deal("deal_mismatch", "person_mismatch"),
        deal("deal_crm_only", "person_crm_only"),
      ],
      paymentRecords: [
        { _id: "record_mismatch", tenantId, opportunityId: "deal_mismatch", recordedAt: window.from,
          amountMinor: 10000, currency: "USD", status: "verified" },
        { _id: "record_crm_only", tenantId, opportunityId: "deal_crm_only", recordedAt: window.from,
          amountMinor: 10000, currency: "USD", status: "verified" },
      ],
    }), { account });
    const { report, sample } = measure({ crm, scans: { first: scan, second: scan, refunds, disputes }, window, asOf });
    const time = { started: asOf, finished: asOf };
    const markdown = renderReport(report, {
      account, window, times: { first: time, second: time }, dryRun: true, sandbox: false,
    });

    expect(report.paid).toBe(72);
    expect(report.comparison).toMatchObject({
      crmCount: 2, crmNoWhop: 1, whopNoCrm: 71, pairs: 1, repeatedCharges: 2, repeatedExcess: 2,
    });
    expect(report.comparison.amounts.get("threeOrMore")).toBe(1);
    expect(report.historical.openCounts.get("2+")).toBe(1);
    expect(report.membership).toMatchObject({ count: 1, max: 2, payments: 2 });
    expect(sample.payments).toHaveLength(60);
    for (const tag of ["unknown", "severalOpen", "renewal", "financing", "refund", "dispute", "mismatch"] as const) {
      expect(report.hardCases.has(tag)).toBe(true);
      expect(sample.payments.some((row) => row.hardCases.includes(HARD_CASES[tag]))).toBe(true);
    }
    expect(markdown).toContain("Account ending in `Ab12`");
    expect(markdown).toContain("pay by bank");
    expect(markdown).toContain("The product never links by amount or time.");
    expect(markdown).not.toMatch(/@|pay_|biz_|person_known|deal_known|prod_synthetic|Synthetic Fixture Name/);
  });

  it("refuses to run without a key unless a fixture is supplied", () => {
    const env = { ...process.env };
    delete env.WHOP_API_KEY;
    const args = [resolve("scripts/whop-measure.mjs"), "--account", account, "--crm", "unused"];
    const live = spawnSync(process.execPath, args, { env, encoding: "utf8" });
    expect(live.status).toBe(1);
    expect(live.stderr).toMatch(/Set WHOP_API_KEY/);

    const fixture = spawnSync(process.execPath, [...args, "--dry-run", "unused", "--allow-repo-output"], {
      env, encoding: "utf8",
    });
    expect(fixture.status).toBe(1);
    expect(fixture.stderr).toMatch(/Missing CRM tables.*leadIdentifiers.*leadMergeHistory/);
    expect(fixture.stderr).not.toMatch(/Set WHOP_API_KEY/);
  });

  it("refuses repo paths, including a symlink into the checkout", () => {
    const folder = mkdtempSync(join(tmpdir(), "whop-measure-test-"));
    try {
      const alias = join(folder, "checkout");
      symlinkSync(process.cwd(), alias, "dir");
      const command = spawnSync(process.execPath, [
        resolve("scripts/whop-measure.mjs"), "--account", account, "--crm", folder,
        "--out", join(folder, "report.md"), "--sample-out", join(alias, "whop-measurement-sample.local.json"),
        "--dry-run", "unused",
      ], { cwd: folder, encoding: "utf8" });
      expect(command.status).toBe(1);
      expect(command.stderr).toMatch(/Refusing --sample-out inside a Git checkout/);
    } finally {
      rmSync(folder, { force: true, recursive: true });
    }
  });
});
