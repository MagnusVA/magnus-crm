import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../schema";
import { convexTestModules } from "../test.setup";
import { loadStaffRedactor, redactAmounts, STAFF_ROSTER_LIMIT } from "./assistantText";

async function tenantWith(names: string[]) {
  const t = convexTest(schema, convexTestModules);
  const tenantId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("tenants", {
      companyName: "Northwind",
      contactEmail: "owner@northwind.example",
      workosOrgId: "org_test",
      status: "active",
      inviteExpiresAt: 0,
      createdBy: "test",
    });
    for (const [index, fullName] of names.entries()) {
      await ctx.db.insert("users", {
        tenantId: id,
        workosUserId: `user_${index}`,
        email: `user${index}@northwind.example`,
        fullName,
        role: "closer",
        isActive: index % 2 === 0,
      });
    }
    return id;
  });
  return { t, tenantId };
}

describe("the staff note redactor", () => {
  it("masks contact details, staff names and amounts, and keeps the rest", async () => {
    const { t, tenantId } = await tenantWith(["Alex Rivera", "María José Núñez"]);
    const result = await t.run(async (ctx) =>
      (await loadStaffRedactor(ctx, tenantId)).safeNote(
        "Alex said she wants María José Núñez to call +1 555 010 9999 or pat@example.com. Quoted $3,000, then 300 USD, L 500 and 5k. Alexandria is fine.",
      ),
    );
    const text = result.note!.text;
    expect(text).not.toMatch(/Alex\b|Rivera|María|Núñez|3,000|300 USD|L 500|5k|pat@example\.com|555 010 9999/);
    expect(text).toContain("[staff] said she wants [staff] to call");
    expect(text).toContain("[amount]");
    // A longer word that only starts with a name is left alone.
    expect(text).toContain("Alexandria is fine.");
    expect(result.note).toMatchObject({ personSupplied: true, truncated: false });
  });

  it("withholds every note when the roster is too large to read in full", async () => {
    const { t, tenantId } = await tenantWith(Array.from({ length: STAFF_ROSTER_LIMIT + 1 }, (_, i) => `Person ${i}`));
    const result = await t.run(async (ctx) => (await loadStaffRedactor(ctx, tenantId)).safeNote("Alex quoted $500"));
    expect(result).toEqual({ note: null, withheld: "staff_roster_too_large" });
  });

  it("trims a long note and says so", async () => {
    const { t, tenantId } = await tenantWith(["Alex Rivera"]);
    const result = await t.run(async (ctx) => (await loadStaffRedactor(ctx, tenantId)).safeNote("x".repeat(700)));
    expect(result.note).toMatchObject({ truncated: true });
    expect(result.note!.text).toHaveLength(500);
  });

  it("redacts amounts written with a symbol, a code or a word", () => {
    for (const amount of ["$3,000", "USD 300", "300 USD", "€1.200,50", "300 dollars", "300 dólares", "2 grand"]) {
      expect(redactAmounts(`She said ${amount} is too much`)).toBe("She said [amount] is too much");
    }
    expect(redactAmounts("Call at 3 on the 14th")).toBe("Call at 3 on the 14th");
  });
});
