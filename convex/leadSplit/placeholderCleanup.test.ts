/**
 * Tier D cleanup (docs/plans/polluted-lead-split.md §3.5): single-person
 * leads that still hold a placeholder identifier or contact field.
 */
import { afterEach, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  AT,
  book,
  insertIdentifier,
  insertLead,
  insertOpportunity,
  setup,
  type Harness,
} from "../../tests/leadSplitFixtures";

afterEach(() => {
  vi.useRealTimers();
});

/** A booker who typed the form's placeholders, plus a clean lead and a merged one. */
async function seed(harness: Harness) {
  const { t, tenantId } = harness;
  return await t.run(async (ctx) => {
    const leadId = await insertLead(ctx, tenantId, {
      fullName: "Dana Placeholder",
      email: "email@yahoo.com",
      phone: "+1 234-567-8912",
      socialHandles: [
        { type: "instagram", handle: "na" },
        { type: "instagram", handle: "dana.coaching" },
      ],
      searchText: "dana placeholder email@yahoo.com +1 234-567-8912 na dana.coaching",
    });
    const opportunityId = await insertOpportunity(ctx, tenantId, leadId);
    const meetingId = await book(ctx, { tenantId, leadId, opportunityId }, { day: 1 });
    const placeholders = [
      await insertIdentifier(ctx, tenantId, leadId, "email", "email@yahoo.com", { sourceMeetingId: meetingId }),
      await insertIdentifier(ctx, tenantId, leadId, "phone", "+12345678912", { sourceMeetingId: meetingId }),
      await insertIdentifier(ctx, tenantId, leadId, "instagram", "na", { sourceMeetingId: meetingId }),
      // The form's example AU number, typed by several bookers.
      await insertIdentifier(ctx, tenantId, leadId, "phone", "+61423567890", { sourceMeetingId: meetingId }),
    ];
    const kept = await insertIdentifier(ctx, tenantId, leadId, "instagram", "dana.coaching", {
      sourceMeetingId: meetingId,
    });
    const cleanLeadId = await insertLead(ctx, tenantId, { email: "real@example.com", phone: "+17789559253" });
    await insertIdentifier(ctx, tenantId, cleanLeadId, "email", "real@example.com");
    const mergedLeadId = await insertLead(ctx, tenantId, { status: "merged", email: "email@icloud.com" });
    return { leadId, placeholders, kept, cleanLeadId, mergedLeadId };
  });
}

async function preview(harness: Harness) {
  return await harness.t.action(internal.leadSplit.placeholderCleanup.preview, {
    tenantId: harness.tenantId,
  });
}

async function leadState(harness: Harness, leadId: Id<"leads">) {
  return await harness.t.run(async (ctx) => {
    const lead = (await ctx.db.get("leads", leadId))!;
    const identifiers = await ctx.db
      .query("leadIdentifiers")
      .withIndex("by_leadId", (q) => q.eq("leadId", leadId))
      .take(20);
    return {
      lead: { email: lead.email, phone: lead.phone, socialHandles: lead.socialHandles, searchText: lead.searchText, updatedAt: lead.updatedAt },
      identifiers: identifiers
        .map(({ type, value, rawValue, source, confidence, createdAt, sourceMeetingId }) => ({
          type, value, rawValue, source, confidence, createdAt, sourceMeetingId,
        }))
        .sort((a, b) => `${a.type}:${a.value}`.localeCompare(`${b.type}:${b.value}`)),
    };
  });
}

it("lists the leads holding placeholders, and why a merged one is left alone", async () => {
  const harness = await setup();
  const { leadId, placeholders, mergedLeadId } = await seed(harness);
  const candidates = await preview(harness);
  expect(candidates).toHaveLength(2);
  expect(candidates.find((candidate) => candidate.leadId === leadId)).toEqual({
    leadId,
    identifierIds: [...placeholders].sort(),
    identifierTypes: expect.arrayContaining(["email", "phone", "instagram"]),
    fields: ["email", "phone", "socialHandles"],
  });
  expect(candidates.find((candidate) => candidate.leadId === mergedLeadId)).toMatchObject({
    fields: ["email"],
    skipped: "merged",
  });
});

it("removes exactly the reviewed placeholders, and undo puts the lead back", async () => {
  const harness = await setup();
  const { t, tenantId } = harness;
  const { leadId, cleanLeadId } = await seed(harness);
  const [candidate] = (await preview(harness)).filter((row) => row.leadId === leadId);
  const before = await leadState(harness, leadId);
  const cleanBefore = await leadState(harness, cleanLeadId);

  vi.setSystemTime(AT + 200 * 86_400_000);
  const args = {
    tenantId,
    leadId,
    identifierIds: candidate.identifierIds,
    fields: candidate.fields,
    approvedBy: "test",
  };
  expect(await t.mutation(internal.leadSplit.placeholderCleanup.cleanLead, args)).toEqual({
    identifiersDeleted: 4,
    fieldsCleared: ["email", "phone", "socialHandles"],
  });
  const after = await leadState(harness, leadId);
  expect(after.identifiers.map((identifier) => `${identifier.type}:${identifier.value}`)).toEqual([
    "instagram:dana.coaching",
  ]);
  expect(after.lead.email).toBeUndefined();
  expect(after.lead.phone).toBeUndefined();
  expect(after.lead.socialHandles).toEqual([{ type: "instagram", handle: "dana.coaching" }]);
  expect(after.lead.searchText).not.toContain("email@yahoo.com");
  expect(after.lead.searchText).toContain("dana.coaching");
  expect(await leadState(harness, cleanLeadId)).toEqual(cleanBefore);
  expect((await preview(harness)).some((row) => row.leadId === leadId)).toBe(false);
  // A second run has nothing left to remove.
  await expect(t.mutation(internal.leadSplit.placeholderCleanup.cleanLead, args)).rejects.toThrow(
    "changed since the preview",
  );

  expect(await t.mutation(internal.leadSplit.placeholderCleanup.undoLead, { tenantId, leadId })).toEqual({
    identifiersRestored: 4,
    leadRestored: true,
  });
  const restored = await leadState(harness, leadId);
  expect(restored.identifiers).toEqual(before.identifiers);
  expect(restored.lead).toEqual(before.lead);
  await expect(t.mutation(internal.leadSplit.placeholderCleanup.undoLead, { tenantId, leadId })).rejects.toThrow(
    "no cleanup to undo",
  );
});

it("refuses a cleanup that no longer matches the preview", async () => {
  const harness = await setup();
  const { t, tenantId } = harness;
  const { leadId, mergedLeadId } = await seed(harness);
  const [candidate] = (await preview(harness)).filter((row) => row.leadId === leadId);
  await expect(
    t.mutation(internal.leadSplit.placeholderCleanup.cleanLead, {
      tenantId,
      leadId,
      identifierIds: candidate.identifierIds.slice(1),
      fields: candidate.fields,
      approvedBy: "test",
    }),
  ).rejects.toThrow("changed since the preview");
  await expect(
    t.mutation(internal.leadSplit.placeholderCleanup.cleanLead, {
      tenantId,
      leadId: mergedLeadId,
      identifierIds: [],
      fields: ["email"],
      approvedBy: "test",
    }),
  ).rejects.toThrow("can't be cleaned: merged");
  // Nothing was written.
  expect(await t.run((ctx) => ctx.db.query("leadPlaceholderCleanups").take(1))).toHaveLength(0);
});

it("won't undo over a contact field someone changed since", async () => {
  const harness = await setup();
  const { t, tenantId } = harness;
  const { leadId } = await seed(harness);
  const [candidate] = (await preview(harness)).filter((row) => row.leadId === leadId);
  await t.mutation(internal.leadSplit.placeholderCleanup.cleanLead, {
    tenantId,
    leadId,
    identifierIds: candidate.identifierIds,
    fields: candidate.fields,
    approvedBy: "test",
  });
  await t.run((ctx) => ctx.db.patch("leads", leadId, { email: "dana@example.com" }));
  await expect(t.mutation(internal.leadSplit.placeholderCleanup.undoLead, { tenantId, leadId })).rejects.toThrow(
    "email changed since the cleanup",
  );
});
