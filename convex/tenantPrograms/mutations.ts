import { v } from "convex/values";
import { internal } from "../_generated/api";
import { mutation } from "../_generated/server";
import { log } from "../lib/observability/log";
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
      const existing = await ctx.db.get("tenantPrograms", args.programId);
      if (!existing || existing.tenantId !== tenantId) {
        throw new Error("Program not found");
      }

      await ctx.db.patch("tenantPrograms", args.programId, {
        name,
        normalizedName,
        description: normalizeOptionalProgramField(args.description),
        defaultCurrency: normalizeOptionalProgramField(args.defaultCurrency),
        updatedAt: now,
      });

      const renamed = existing.name !== name;
      if (renamed) {
        await ctx.scheduler.runAfter(
          0,
          internal.tenantPrograms.sync.syncRenamedProgram,
          { programId: args.programId },
        );
      }

      log.info("program.updated", {
        tenantId,
        programId: args.programId,
        renamed,
      });
      return args.programId;
    }

    const programId = await ctx.db.insert("tenantPrograms", {
      tenantId,
      name,
      normalizedName,
      description: normalizeOptionalProgramField(args.description),
      defaultCurrency: normalizeOptionalProgramField(args.defaultCurrency),
      createdAt: now,
      createdByUserId: userId,
      updatedAt: now,
    });
    log.info("program.created", { tenantId, programId });
    return programId;
  },
});

export const archiveProgram = mutation({
  args: { programId: v.id("tenantPrograms") },
  handler: async (ctx, { programId }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const program = await ctx.db.get("tenantPrograms", programId);
    if (!program || program.tenantId !== tenantId) {
      throw new Error("Program not found");
    }
    if (program.archivedAt !== undefined) {
      log.info("program.archive_skipped", {
        tenantId,
        programId,
        reason: "already_archived",
      });
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

    await ctx.db.patch("tenantPrograms", programId, {
      archivedAt: Date.now(),
      updatedAt: Date.now(),
    });
    log.info("program.archived", {
      tenantId,
      programId,
      remainingActiveCount: activeCount - 1,
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

    const program = await ctx.db.get("tenantPrograms", programId);
    if (!program || program.tenantId !== tenantId) {
      throw new Error("Program not found");
    }
    if (program.archivedAt === undefined) {
      log.info("program.restore_skipped", {
        tenantId,
        programId,
        reason: "not_archived",
      });
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

    await ctx.db.patch("tenantPrograms", programId, {
      archivedAt: undefined,
      updatedAt: Date.now(),
    });
    log.info("program.restored", { tenantId, programId });
  },
});
