"use client";

import { useCallback, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { MaximizeIcon, MessageSquareIcon } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import { CommentEntry } from "./comment-entry";
import { CommentInput } from "./comment-input";
import { DetailCard } from "./detail-card";
import { getErrorMessage } from "@/lib/errors";
import { useBusinessDay } from "@/hooks/use-business-day";

type MeetingCommentsProps = {
  meetingId: Id<"meetings">;
};

export function MeetingComments({ meetingId }: MeetingCommentsProps) {
  const [expanded, setExpanded] = useState(false);
  const { setting } = useBusinessDay();
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
          getErrorMessage(error, "Failed to delete comment"),
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
        <p className="py-6 text-center text-muted-foreground">
          No comments yet.
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
            timeZone={setting.timeZone}
          />
        ))}
      </div>
    );
    if (maxHeight) {
      return (
        <div
          className="overflow-y-auto overscroll-contain"
          // Scroll shadows: the bottom edge darkens while more comments sit
          // below, and the cover scrolls away at the end of the list.
          style={{
            maxHeight,
            background:
              "linear-gradient(var(--card) 30%, transparent) top / 100% 24px no-repeat local, linear-gradient(transparent, var(--card) 70%) bottom / 100% 24px no-repeat local, radial-gradient(farthest-side at 50% 0, color-mix(in oklab, var(--foreground) 14%, transparent), transparent) top / 100% 10px no-repeat scroll, radial-gradient(farthest-side at 50% 100%, color-mix(in oklab, var(--foreground) 14%, transparent), transparent) bottom / 100% 10px no-repeat scroll",
          }}
          tabIndex={0}
          role="region"
          aria-label="Comment list"
        >
          {list}
        </div>
      );
    }
    return list;
  };

  return (
    <>
      <DetailCard
        title="Comments"
        meta={
          <>
            <span className="tabular-nums">
              {isLoading ? null : comments.length}
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="-mr-2 text-muted-foreground"
                  onClick={() => setExpanded(true)}
                  aria-label="Open comments in a larger view"
                >
                  <MaximizeIcon className="size-3.5" aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">Open larger view</TooltipContent>
            </Tooltip>
          </>
        }
      >
        {isLoading || comments.length > 0 ? (
          <div>{commentList("260px")}</div>
        ) : null}
        <div className={isLoading || comments.length > 0 ? "border-t px-4 py-3" : "px-4 py-3"}>
          <CommentInput meetingId={meetingId} />
        </div>
      </DetailCard>

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
          <div className="flex-1 overflow-y-auto px-2">
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
