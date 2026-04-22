import { v } from "convex/values";
import { internal } from "../_generated/api";
import { mutation } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { validateRequiredString } from "../lib/validation";
import {
  findProgramByNormalizedName,
  listProgramsForTenant,
  normalizeOptionalProgramField,
  normalizeProgramName,
} from "./shared";

export const upsertProgram = mutation({
  args: {
    programId: v.optional(v.id("tenantPrograms")),
    name: v.string(),
    description: v.optional(v.string()),
    defaultCurrency: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    console.log("[Programs] upsertProgram called", {
      isUpdate: args.programId !== undefined,
    });

    const { userId, tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const validation = validateRequiredString(args.name, {
      fieldName: "Program name",
      maxLength: 80,
    });
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    const name = args.name.trim();
    const normalizedName = normalizeProgramName(name);
    const now = Date.now();

    const clash = await findProgramByNormalizedName(ctx, tenantId, normalizedName);
    if (
      clash &&
      clash._id !== args.programId &&
      clash.archivedAt === undefined
    ) {
      throw new Error(`A program named "${name}" already exists.`);
    }

    if (args.programId) {
      const existing = await ctx.db.get(args.programId);
      if (!existing || existing.tenantId !== tenantId) {
        throw new Error("Program not found");
      }

      await ctx.db.patch(args.programId, {
        name,
        normalizedName,
        description: normalizeOptionalProgramField(args.description),
        defaultCurrency: normalizeOptionalProgramField(args.defaultCurrency),
        updatedAt: now,
      });

      if (existing.name !== name) {
        await ctx.scheduler.runAfter(
          0,
          internal.tenantPrograms.sync.syncRenamedProgram,
          { programId: args.programId },
        );
      }

      return args.programId;
    }

    return await ctx.db.insert("tenantPrograms", {
      tenantId,
      name,
      normalizedName,
      description: normalizeOptionalProgramField(args.description),
      defaultCurrency: normalizeOptionalProgramField(args.defaultCurrency),
      createdAt: now,
      createdByUserId: userId,
      updatedAt: now,
    });
  },
});

export const archiveProgram = mutation({
  args: { programId: v.id("tenantPrograms") },
  handler: async (ctx, { programId }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const program = await ctx.db.get(programId);
    if (!program || program.tenantId !== tenantId) {
      throw new Error("Program not found");
    }
    if (program.archivedAt !== undefined) {
      return;
    }

    const programs = await listProgramsForTenant(ctx, tenantId);
    const activeCount = programs.filter(
      (existing) => existing.archivedAt === undefined,
    ).length;
    if (activeCount <= 1) {
      throw new Error(
        "At least one active program is required. Create or restore another program before archiving this one.",
      );
    }

    await ctx.db.patch(programId, {
      archivedAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});

export const restoreProgram = mutation({
  args: { programId: v.id("tenantPrograms") },
  handler: async (ctx, { programId }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const program = await ctx.db.get(programId);
    if (!program || program.tenantId !== tenantId) {
      throw new Error("Program not found");
    }
    if (program.archivedAt === undefined) {
      return;
    }

    const clash = await findProgramByNormalizedName(
      ctx,
      tenantId,
      program.normalizedName,
    );
    if (
      clash &&
      clash._id !== programId &&
      clash.archivedAt === undefined
    ) {
      throw new Error(
        `Cannot restore "${program.name}" because an active program with that name already exists.`,
      );
    }

    await ctx.db.patch(programId, {
      archivedAt: undefined,
      updatedAt: Date.now(),
    });
  },
});
