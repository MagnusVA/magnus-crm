import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { getUserDisplayName } from "../reporting/lib/helpers";
import { loadMeetingContext } from "./meetingActions";

const MAX_COMMENT_LENGTH = 5000;
const MAX_COMMENTS_PER_MEETING = 200;

export const addComment = mutation({
  args: {
    meetingId: v.id("meetings"),
    content: v.string(),
  },
  handler: async (ctx, { meetingId, content }) => {
    const { userId, tenantId, role } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);

    const trimmed = content.trim();
    if (trimmed.length === 0) {
      throw new Error("Comment cannot be empty");
    }
    if (trimmed.length > MAX_COMMENT_LENGTH) {
      throw new Error(`Comment exceeds ${MAX_COMMENT_LENGTH} character limit`);
    }

    const { opportunity } = await loadMeetingContext(ctx, meetingId, tenantId);
    if (role === "closer" && opportunity.assignedCloserId !== userId) {
      throw new Error("Not your meeting");
    }

    const commentId = await ctx.db.insert("meetingComments", {
      tenantId,
      meetingId,
      authorId: userId,
      content: trimmed,
      createdAt: Date.now(),
    });

    console.log(
      "[Comments] addComment | meetingId=%s authorId=%s commentId=%s",
      meetingId,
      userId,
      commentId,
    );

    return commentId;
  },
});

export const editComment = mutation({
  args: {
    commentId: v.id("meetingComments"),
    content: v.string(),
  },
  handler: async (ctx, { commentId, content }) => {
    const { userId, tenantId } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);

    const comment = await ctx.db.get(commentId);
    if (!comment || comment.tenantId !== tenantId) {
      throw new Error("Comment not found");
    }
    if (comment.deletedAt !== undefined) {
      throw new Error("Cannot edit a deleted comment");
    }
    if (comment.authorId !== userId) {
      throw new Error("You can only edit your own comments");
    }

    const trimmed = content.trim();
    if (trimmed.length === 0) {
      throw new Error("Comment cannot be empty");
    }
    if (trimmed.length > MAX_COMMENT_LENGTH) {
      throw new Error(`Comment exceeds ${MAX_COMMENT_LENGTH} character limit`);
    }

    await ctx.db.patch(commentId, {
      content: trimmed,
      editedAt: Date.now(),
    });

    console.log(
      "[Comments] editComment | commentId=%s authorId=%s",
      commentId,
      userId,
    );
  },
});

export const deleteComment = mutation({
  args: {
    commentId: v.id("meetingComments"),
  },
  handler: async (ctx, { commentId }) => {
    const { userId, tenantId, role } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const comment = await ctx.db.get(commentId);
    if (!comment || comment.tenantId !== tenantId) {
      throw new Error("Comment not found");
    }
    if (comment.deletedAt !== undefined) {
      return;
    }

    await ctx.db.patch(commentId, {
      deletedAt: Date.now(),
    });

    console.log(
      "[Comments] deleteComment | commentId=%s deletedBy=%s role=%s",
      commentId,
      userId,
      role,
    );
  },
});

export const getComments = query({
  args: {
    meetingId: v.id("meetings"),
  },
  handler: async (ctx, { meetingId }) => {
    const { userId, tenantId, role } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);

    const meeting = await ctx.db.get(meetingId);
    if (!meeting || meeting.tenantId !== tenantId) {
      return [];
    }

    if (role === "closer") {
      const opportunity = await ctx.db.get(meeting.opportunityId);
      if (!opportunity || opportunity.tenantId !== tenantId) {
        return [];
      }
      if (opportunity.assignedCloserId !== userId) {
        return [];
      }
    }

    const comments = await ctx.db
      .query("meetingComments")
      .withIndex("by_meetingId_and_createdAt", (q) =>
        q.eq("meetingId", meetingId),
      )
      .take(MAX_COMMENTS_PER_MEETING);

    const activeComments = comments.filter(
      (comment) =>
        comment.tenantId === tenantId && comment.deletedAt === undefined,
    );

    const authorIds = [...new Set(activeComments.map((comment) => comment.authorId))];
    const authorEntries = await Promise.all(
      authorIds.map(async (authorId) => [
        authorId,
        await ctx.db.get(authorId),
      ] as const),
    );
    const authorById = new Map(authorEntries);

    return activeComments.map((comment) => {
      const author = authorById.get(comment.authorId);
      return {
        _id: comment._id,
        content: comment.content,
        createdAt: comment.createdAt,
        editedAt: comment.editedAt ?? null,
        authorId: comment.authorId,
        authorName: getUserDisplayName(author),
        authorRole: author?.role ?? null,
        isOwn: comment.authorId === userId,
      };
    });
  },
});
