import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { validateRequiredString } from "../lib/validation";

type ProgramWriteCtx = Pick<MutationCtx, "db">;
type ProgramReadCtx = Pick<MutationCtx, "db"> | Pick<QueryCtx, "db">;

export const MAX_TENANT_PROGRAMS = 200;

export function normalizeProgramName(name: string): string {
  return name.trim().toLocaleLowerCase();
}

export function normalizeOptionalProgramField(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export async function listProgramsForTenant(
  ctx: ProgramReadCtx,
  tenantId: Id<"tenants">,
): Promise<Array<Doc<"tenantPrograms">>> {
  return await ctx.db
    .query("tenantPrograms")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
    .take(MAX_TENANT_PROGRAMS);
}

export async function findProgramByNormalizedName(
  ctx: ProgramReadCtx,
  tenantId: Id<"tenants">,
  normalizedName: string,
): Promise<Doc<"tenantPrograms"> | null> {
  return await ctx.db
    .query("tenantPrograms")
    .withIndex("by_tenantId_and_normalizedName", (q) =>
      q.eq("tenantId", tenantId).eq("normalizedName", normalizedName),
    )
    .unique();
}

export async function ensureProgramForTenant(
  ctx: ProgramWriteCtx,
  args: {
    tenantId: Id<"tenants">;
    createdByUserId: Id<"users">;
    name: string;
    description?: string;
    defaultCurrency?: string;
  },
): Promise<Doc<"tenantPrograms">> {
  const validation = validateRequiredString(args.name, {
    fieldName: "Program name",
    maxLength: 80,
  });
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const name = args.name.trim();
  const normalizedName = normalizeProgramName(name);
  const existing = await findProgramByNormalizedName(
    ctx,
    args.tenantId,
    normalizedName,
  );
  if (existing) {
    if (existing.archivedAt !== undefined) {
      await ctx.db.patch(existing._id, {
        archivedAt: undefined,
        updatedAt: Date.now(),
      });
      return {
        ...existing,
        archivedAt: undefined,
        updatedAt: Date.now(),
      };
    }
    return existing;
  }

  const now = Date.now();
  const programId = await ctx.db.insert("tenantPrograms", {
    tenantId: args.tenantId,
    name,
    normalizedName,
    description: normalizeOptionalProgramField(args.description),
    defaultCurrency: normalizeOptionalProgramField(args.defaultCurrency),
    createdAt: now,
    createdByUserId: args.createdByUserId,
    updatedAt: now,
  });

  const program = await ctx.db.get(programId);
  if (!program) {
    throw new Error("Failed to create tenant program");
  }

  return program;
}

export function sortProgramsForDisplay(
  programs: Array<Doc<"tenantPrograms">>,
): Array<Doc<"tenantPrograms">> {
  return [...programs].sort((left, right) => {
    const leftArchived = left.archivedAt !== undefined ? 1 : 0;
    const rightArchived = right.archivedAt !== undefined ? 1 : 0;
    if (leftArchived !== rightArchived) {
      return leftArchived - rightArchived;
    }
    return left.name.localeCompare(right.name, undefined, {
      sensitivity: "base",
    });
  });
}
