import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  isLinkCode,
  normalizeLinkCode,
  pickUniqueLinkCode,
  programLinkCodes,
  slugifyLinkCode,
} from "../lib/closerLinks";
import { expectedError } from "../lib/observability/errors";
import { validateRequiredString } from "../lib/validation";

type ProgramWriteCtx = Pick<MutationCtx, "db">;
type ProgramReadCtx = Pick<MutationCtx, "db"> | Pick<QueryCtx, "db">;

export const MAX_TENANT_PROGRAMS = 200;
// Link codes are unique across every program in a tenant, archived ones and
// retired codes included, so allocation reads them all. More programs than
// this is far past any real tenant; it fails loudly rather than miss a code.
const MAX_LINK_CODE_SCAN = 1000;

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
    .withIndex("by_tenantId_and_archivedAt", (q) => q.eq("tenantId", tenantId))
    .take(MAX_TENANT_PROGRAMS);
}

/** Every link code in the tenant, current and retired, mapped to its program. */
export async function linkCodeOwners(
  ctx: ProgramReadCtx,
  tenantId: Id<"tenants">,
): Promise<Map<string, Id<"tenantPrograms">>> {
  const programs = await ctx.db
    .query("tenantPrograms")
    .withIndex("by_tenantId_and_archivedAt", (q) => q.eq("tenantId", tenantId))
    .take(MAX_LINK_CODE_SCAN + 1);
  if (programs.length > MAX_LINK_CODE_SCAN) {
    throw new Error("Too many programs to check link codes.");
  }
  const owners = new Map<string, Id<"tenantPrograms">>();
  for (const program of programs) {
    for (const code of programLinkCodes(program)) owners.set(code, program._id);
  }
  return owners;
}

/** A free code for a new program, suggested from its name. */
export async function allocateProgramLinkCode(
  ctx: ProgramReadCtx,
  tenantId: Id<"tenants">,
  name: string,
): Promise<string> {
  const owners = await linkCodeOwners(ctx, tenantId);
  return pickUniqueLinkCode(slugifyLinkCode(name), new Set(owners.keys()));
}

/**
 * Checks a code an admin typed for `programId` (undefined: a new program) and
 * returns it normalized. A code another program holds or once held is
 * refused, so a link already sent never resolves to another program.
 */
export async function checkProgramLinkCode(
  ctx: ProgramReadCtx,
  tenantId: Id<"tenants">,
  programId: Id<"tenantPrograms"> | undefined,
  raw: string,
): Promise<string> {
  const code = normalizeLinkCode(raw);
  if (!isLinkCode(code)) {
    throw expectedError(
      "program.link_code_invalid",
      "Link codes use lowercase letters, numbers and dashes, up to 24 characters.",
    );
  }
  const owner = (await linkCodeOwners(ctx, tenantId)).get(code);
  if (owner !== undefined && owner !== programId) {
    throw expectedError(
      "program.link_code_taken",
      `The link code "${code}" is used by another program.`,
    );
  }
  return code;
}

/**
 * The fields that move `program` to `code`: its old code is retired, so links
 * already sent with it never resolve to another program. Taking back a code
 * the program retired earlier un-retires it.
 */
export function linkCodeChange(
  program: Pick<Doc<"tenantPrograms">, "linkCode" | "retiredLinkCodes">,
  code: string,
): Pick<Doc<"tenantPrograms">, "linkCode" | "retiredLinkCodes"> {
  const retired = new Set(program.retiredLinkCodes ?? []);
  if (program.linkCode && program.linkCode !== code) retired.add(program.linkCode);
  retired.delete(code);
  return {
    linkCode: code,
    retiredLinkCodes: retired.size > 0 ? [...retired] : undefined,
  };
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
      await ctx.db.patch("tenantPrograms", existing._id, {
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
    linkCode: await allocateProgramLinkCode(ctx, args.tenantId, name),
    description: normalizeOptionalProgramField(args.description),
    defaultCurrency: normalizeOptionalProgramField(args.defaultCurrency),
    createdAt: now,
    createdByUserId: args.createdByUserId,
    updatedAt: now,
  });

  const program = await ctx.db.get("tenantPrograms", programId);
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
