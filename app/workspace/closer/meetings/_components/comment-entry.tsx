"use client";

import { useCallback, useState } from "react";
import { useMutation } from "convex/react";
import { formatDistanceToNow } from "date-fns";
import { MoreHorizontalIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useRole } from "@/components/auth/role-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";

import { CommentContent } from "./comment-content";

type CommentEntryProps = {
  comment: {
    _id: Id<"meetingComments">;
    content: string;
    createdAt: number;
    editedAt: number | null;
    authorName: string;
    authorRole: "tenant_master" | "tenant_admin" | "closer" | null;
    isOwn: boolean;
  };
  onDelete: (commentId: Id<"meetingComments">) => void;
};

const ROLE_LABEL: Record<
  NonNullable<CommentEntryProps["comment"]["authorRole"]>,
  string
> = {
  tenant_master: "Owner",
  tenant_admin: "Admin",
  closer: "Closer",
};

export function CommentEntry({ comment, onDelete }: CommentEntryProps) {
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
        error instanceof Error ? error.message : "Failed to save edit",
      );
    } finally {
      setIsSaving(false);
    }
  }, [editValue, comment.content, comment._id, editComment, isSaving]);

  return (
    <div className="group flex gap-3 py-3">
      <div
        aria-hidden
        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-foreground"
      >
        {comment.authorName.charAt(0).toUpperCase()}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">
            {comment.authorName}
          </span>
          {comment.authorRole && (
            <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
              {ROLE_LABEL[comment.authorRole]}
            </Badge>
          )}
          <span className="text-xs text-muted-foreground">
            {formatDistanceToNow(comment.createdAt, { addSuffix: true })}
          </span>
          {comment.editedAt && (
            <span className="text-[10px] italic text-muted-foreground">
              (edited)
            </span>
          )}

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

        <div className="mt-1">
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
