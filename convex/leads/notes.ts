// NIM-17 Phase 5: workspace-facing view of leadNotes.
//
// Same row shape as the portal's listPortalLeadNotes, but authorLabel
// resolves workspace users by name (the portal deliberately collapses them to
// "Team"). Guarded with the same roles as getLeadDetail.

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

const NOTES_RESULT_LIMIT = 50;

export const listLeadNotes = query({
  args: {
    leadId: v.id("leads"),
  },
  returns: v.array(
    v.object({
      noteId: v.id("leadNotes"),
      content: v.string(),
      createdAt: v.number(),
      authorKind: v.union(v.literal("dm_closer"), v.literal("user")),
      authorLabel: v.string(),
    }),
  ),
  handler: async (ctx, { leadId }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
      "closer",
    ]);

    const lead = await ctx.db.get(leadId);
    if (!lead || lead.tenantId !== tenantId) {
      throw new Error("Lead not found");
    }

    const notes = await ctx.db
      .query("leadNotes")
      .withIndex("by_tenantId_and_leadId", (q) =>
        q.eq("tenantId", tenantId).eq("leadId", leadId),
      )
      .order("desc")
      .take(NOTES_RESULT_LIMIT);
    const visibleNotes = notes.filter((note) => note.deletedAt === undefined);

    const dmCloserIds = [
      ...new Set(
        visibleNotes
          .map((note) => note.dmCloserId)
          .filter((id): id is Id<"dmClosers"> => id !== undefined),
      ),
    ];
    const userIds = [
      ...new Set(
        visibleNotes
          .map((note) => note.userId)
          .filter((id): id is Id<"users"> => id !== undefined),
      ),
    ];

    const [dmClosers, users] = await Promise.all([
      Promise.all(
        dmCloserIds.map(async (dmCloserId) => ({
          dmCloserId,
          dmCloser: await ctx.db.get(dmCloserId),
        })),
      ),
      Promise.all(
        userIds.map(async (userId) => ({
          userId,
          user: await ctx.db.get(userId),
        })),
      ),
    ]);

    const dmCloserLabelById = new Map<Id<"dmClosers">, string>(
      dmClosers.map(({ dmCloserId, dmCloser }) => [
        dmCloserId,
        dmCloser && dmCloser.tenantId === tenantId
          ? dmCloser.displayName
          : "DM closer",
      ]),
    );
    const userLabelById = new Map<Id<"users">, string>(
      users.map(({ userId, user }) => [
        userId,
        user && user.tenantId === tenantId
          ? user.fullName ?? user.email ?? "Team"
          : "Team",
      ]),
    );

    return visibleNotes.map((note) => ({
      noteId: note._id,
      content: note.content,
      createdAt: note.createdAt,
      authorKind: note.authorKind,
      authorLabel:
        note.authorKind === "dm_closer"
          ? (note.dmCloserId
              ? dmCloserLabelById.get(note.dmCloserId)
              : undefined) ?? "DM closer"
          : (note.userId ? userLabelById.get(note.userId) : undefined) ??
            "Team",
    }));
  },
});
