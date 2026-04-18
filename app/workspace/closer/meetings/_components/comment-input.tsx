"use client";

import { useCallback, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { SendIcon } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

type CommentInputProps = {
  meetingId: Id<"meetings">;
};

export function CommentInput({ meetingId }: CommentInputProps) {
  const [content, setContent] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const addComment = useMutation(api.closer.meetingComments.addComment);

  const handleSubmit = useCallback(async () => {
    const trimmed = content.trim();
    if (!trimmed || isSubmitting) return;

    setIsSubmitting(true);
    try {
      await addComment({ meetingId, content: trimmed });
      setContent("");
      textareaRef.current?.focus();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to post comment",
      );
    } finally {
      setIsSubmitting(false);
    }
  }, [content, meetingId, addComment, isSubmitting]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter submits; Shift+Enter inserts a newline.
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  return (
    <div className="flex gap-2">
      <Textarea
        ref={textareaRef}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Add a comment… (Enter to send, Shift+Enter for newline)"
        className="min-h-[80px] resize-y"
        aria-label="New comment"
        disabled={isSubmitting}
      />
      <Button
        size="icon"
        onClick={handleSubmit}
        disabled={!content.trim() || isSubmitting}
        className="shrink-0 self-end"
        aria-label="Post comment"
      >
        <SendIcon className="size-4" />
      </Button>
    </div>
  );
}
