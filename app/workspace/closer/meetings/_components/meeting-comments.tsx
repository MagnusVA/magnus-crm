"use client";

import { useCallback, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { MaximizeIcon, MessageSquareIcon } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import { CommentEntry } from "./comment-entry";
import { CommentInput } from "./comment-input";

type MeetingCommentsProps = {
  meetingId: Id<"meetings">;
};

export function MeetingComments({ meetingId }: MeetingCommentsProps) {
  const [expanded, setExpanded] = useState(false);
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

  const commentList = (maxHeight?: string) => {
    if (isLoading) {
      return (
        <div
          className="flex items-center justify-center py-6"
          role="status"
          aria-label="Loading comments"
        >
          <Spinner className="size-5" />
        </div>
      );
    }
    if (comments.length === 0) {
      return (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No comments yet. Be the first to add one.
        </p>
      );
    }
    const list = (
      <div className="divide-y">
        {comments.map((comment) => (
          <CommentEntry
            key={comment._id}
            comment={comment}
            onDelete={handleDelete}
          />
        ))}
      </div>
    );
    if (maxHeight) {
      return (
        <ScrollArea className="pr-2" style={{ maxHeight }}>
          {list}
        </ScrollArea>
      );
    }
    return list;
  };

  return (
    <>
      <Card size="sm">
        <CardHeader>
          <div className="flex items-center gap-2">
            <MessageSquareIcon
              className="size-4 text-muted-foreground"
              aria-hidden
            />
            <CardTitle className="text-sm">Comments</CardTitle>
            {!isLoading && comments.length > 0 && (
              <span className="text-xs text-muted-foreground">
                ({comments.length})
              </span>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="ml-auto size-7"
                  onClick={() => setExpanded(true)}
                  aria-label="Expand comments"
                >
                  <MaximizeIcon className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">Open larger view</TooltipContent>
            </Tooltip>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {commentList("260px")}
          <CommentInput meetingId={meetingId} />
        </CardContent>
      </Card>

      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="flex max-h-[80vh] flex-col gap-0 p-0 sm:max-w-3xl">
          <DialogHeader className="border-b px-6 py-4">
            <DialogTitle className="flex items-center gap-2 text-base">
              <MessageSquareIcon className="size-4 text-muted-foreground" aria-hidden />
              Comments
              {!isLoading && comments.length > 0 && (
                <span className="text-xs font-normal text-muted-foreground">
                  ({comments.length})
                </span>
              )}
            </DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto px-6">
            {commentList()}
          </div>
          <div className="border-t px-6 py-4">
            <CommentInput meetingId={meetingId} />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
