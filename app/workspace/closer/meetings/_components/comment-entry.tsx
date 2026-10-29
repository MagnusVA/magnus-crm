"use client";

import { useCallback, useState } from "react";
import { useMutation } from "convex/react";
import { MoreHorizontalIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useRole } from "@/components/auth/role-context";
import type { MemberAvatarIdentity } from "@/app/workspace/_components/member-avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";

import { CommentContent } from "./comment-content";
import { getErrorMessage } from "@/lib/errors";

type CommentEntryProps = {
  comment: {
    _id: Id<"meetingComments">;
    content: string;
    createdAt: number;
    editedAt: number | null;
    authorName: string;
    author: MemberAvatarIdentity;
    authorRole:
      | "tenant_master"
      | "tenant_admin"
      | "closer"
      | "lead_generator"
      | null;
    isOwn: boolean;
  };
  onDelete: (commentId: Id<"meetingComments">) => void;
  /** The tenant's business time zone, for the comment's date. */
  timeZone: string;
};

const ROLE_LABEL: Record<
  NonNullable<CommentEntryProps["comment"]["authorRole"]>,
  string
> = {
  tenant_master: "Owner",
  tenant_admin: "Admin",
  closer: "Closer",
  lead_generator: "Lead generator",
};

/** "Oct 27, 4:12 PM", with the year when it isn't this year's. */
function commentDate(ms: number, timeZone: string) {
  const year = (at: number) =>
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" }).format(at);
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    year: year(ms) === year(Date.now()) ? undefined : "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(ms);
}

function commentDateFull(ms: number, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    dateStyle: "full",
    timeStyle: "short",
  }).format(ms);
}

/** One comment as a ruled row, like Prep's notes: "Name · role · date", then the text. */
export function CommentEntry({ comment, onDelete, timeZone }: CommentEntryProps) {
  const { isAdmin } = useRole();
  const editComment = useMutation(api.closer.meetingComments.editComment);

  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(comment.content);
  const [isSaving, setIsSaving] = useState(false);

  const canEdit = comment.isOwn;
  const canDelete = isAdmin;
  const hasActions = canEdit || canDelete;

  const handleStartEdit = useCallback(() => {
    setEditValue(comment.content);
    setIsEditing(true);
  }, [comment.content]);

  const handleCancelEdit = useCallback(() => {
    setIsEditing(false);
    setEditValue(comment.content);
  }, [comment.content]);

  const handleSaveEdit = useCallback(async () => {
    const trimmed = editValue.trim();
    if (!trimmed || trimmed === comment.content || isSaving) {
      setIsEditing(false);
      return;
    }
    setIsSaving(true);
    try {
      await editComment({ commentId: comment._id, content: trimmed });
      setIsEditing(false);
    } catch (error) {
      toast.error(
        getErrorMessage(error, "Failed to save edit"),
      );
    } finally {
      setIsSaving(false);
    }
  }, [editValue, comment.content, comment._id, editComment, isSaving]);

  return (
    <div className="group px-4 py-2.5">
      <div className="min-w-0">
        <div className="flex min-h-6 items-center gap-2">
          <p className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
            <span className="font-semibold">{comment.authorName}</span>
            <span className="text-[0.8125rem] text-muted-foreground">
              {comment.authorRole ? `${ROLE_LABEL[comment.authorRole]} · ` : null}
              <time
                dateTime={new Date(comment.createdAt).toISOString()}
                title={commentDateFull(comment.createdAt, timeZone)}
                className="tabular-nums"
              >
                {commentDate(comment.createdAt, timeZone)}
              </time>
              {comment.editedAt ? " · edited" : null}
            </span>
          </p>

          {hasActions && !isEditing && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="ml-auto size-6 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                >
                  <MoreHorizontalIcon className="size-3.5" />
                  <span className="sr-only">Comment actions</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {canEdit && (
                  <DropdownMenuItem onClick={handleStartEdit}>
                    <PencilIcon className="mr-2 size-3.5" />
                    Edit
                  </DropdownMenuItem>
                )}
                {canDelete && (
                  <DropdownMenuItem
                    onClick={() => onDelete(comment._id)}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2Icon className="mr-2 size-3.5" />
                    Delete
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        <div className="mt-0.5">
          {isEditing ? (
            <div className="flex flex-col gap-2">
              <Textarea
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={(e) => {
                  // Enter saves; Shift+Enter inserts a newline; Escape cancels.
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSaveEdit();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    handleCancelEdit();
                  }
                }}
                className="min-h-[60px] resize-y"
                autoFocus
                aria-label="Edit comment"
                disabled={isSaving}
              />
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleCancelEdit}
                  disabled={isSaving}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={handleSaveEdit}
                  disabled={!editValue.trim() || isSaving}
                >
                  Save
                </Button>
              </div>
            </div>
          ) : (
            <CommentContent content={comment.content} />
          )}
        </div>
      </div>
    </div>
  );
}
