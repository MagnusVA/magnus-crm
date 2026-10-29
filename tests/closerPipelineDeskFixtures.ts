import type { Doc, Id } from "../convex/_generated/dataModel";
import type { MutationCtx } from "../convex/_generated/server";
import { upsertOpportunitySearchProjection } from "../convex/lib/opportunitySearch";
import { T0 } from "./closerPipelineFixtures";

// My Pipeline's desk and lookup (convex/closer/pipelineDesk.ts, pipeline.ts):
// programs, the closer's payments in them, and the search rows the lookup's
// person search reads. Built on the closer pipeline seed.

/** A program of the tenant's, named `name`. */
export async function insertProgram(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  createdByUserId: Id<"users">,
  name: string,
): Promise<Id<"tenantPrograms">> {
  return await ctx.db.insert("tenantPrograms", {
    tenantId,
    name,
    normalizedName: name.toLowerCase(),
    createdAt: 0,
    createdByUserId,
    updatedAt: 0,
  });
}

/** A payment attributed to `closerId`, recorded at `recordedAt` (T0 by default). */
export async function insertCloserPayment(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    closerId: Id<"users">;
    programId: Id<"tenantPrograms">;
    amountMinor: number;
    currency?: string;
    opportunityId?: Id<"opportunities">;
    recordedAt?: number;
    status?: Doc<"paymentRecords">["status"];
    paymentType?: Doc<"paymentRecords">["paymentType"];
    programName?: string;
  },
): Promise<Id<"paymentRecords">> {
  return await ctx.db.insert("paymentRecords", {
    tenantId: args.tenantId,
    opportunityId: args.opportunityId,
    attributedCloserId: args.closerId,
    amountMinor: args.amountMinor,
    currency: args.currency ?? "USD",
    recordedByUserId: args.closerId,
    programId: args.programId,
    programName: args.programName ?? "Payment's program name",
    paymentType: args.paymentType ?? "pif",
    status: args.status ?? "recorded",
    recordedAt: args.recordedAt ?? T0,
    origin: "closer_meeting",
  });
}

/** Names the deal's person and writes the deal's search row from it. */
export async function namePersonForSearch(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
  fullName: string,
): Promise<void> {
  const deal = (await ctx.db.get("opportunities", opportunityId))!;
  await ctx.db.patch("leads", deal.leadId, {
    fullName,
    email: `${fullName.toLowerCase().replace(/\s+/g, ".")}@example.com`,
    searchText: fullName,
  });
  await upsertOpportunitySearchProjection(ctx, opportunityId);
}
