"use client";

import { useCallback } from "react";
import { useMutation, useQuery } from "convex/react";
import { MessageSquareIcon } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";

import { CommentEntry } from "./comment-entry";
import { CommentInput } from "./comment-input";

type MeetingCommentsProps = {
  meetingId: Id<"meetings">;
};

export function MeetingComments({ meetingId }: MeetingCommentsProps) {
  const comments = useQuery(api.closer.meetingComments.getComments, {
    meetingId,
  });
  const deleteComment = useMutation(api.closer.meetingComments.deleteComment);

  const handleDelete = useCallback(
    async (commentId: Id<"meetingComments">) => {
      try {
        await deleteComment({ commentId });
        toast.success("Comment deleted");
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to delete comment",
        );
      }
    },
    [deleteComment],
  );

  const isLoading = comments === undefined;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <MessageSquareIcon
            className="size-4 text-muted-foreground"
            aria-hidden
          />
          <CardTitle className="text-base">Comments</CardTitle>
          {!isLoading && comments.length > 0 && (
            <span className="text-xs text-muted-foreground">
              ({comments.length})
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {isLoading ? (
          <div
            className="flex items-center justify-center py-6"
            role="status"
            aria-label="Loading comments"
          >
            <Spinner className="size-5" />
          </div>
        ) : comments.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No comments yet. Be the first to add one.
          </p>
        ) : (
          <div className="max-h-[400px] divide-y overflow-y-auto">
            {comments.map((comment) => (
              <CommentEntry
                key={comment._id}
                comment={comment}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}

        <CommentInput meetingId={meetingId} />
      </CardContent>
    </Card>
  );
}
