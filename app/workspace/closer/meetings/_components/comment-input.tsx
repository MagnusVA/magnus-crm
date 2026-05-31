"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { CornerDownLeftIcon, SendIcon } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type CommentInputProps = {
  meetingId: Id<"meetings">;
};

const ENTER_BEHAVIOR_KEY = "meeting-comment-enter-behavior";
type EnterBehavior = "send" | "newline";

export function CommentInput({ meetingId }: CommentInputProps) {
  const [content, setContent] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [enterBehavior, setEnterBehavior] = useState<EnterBehavior>("send");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const addComment = useMutation(api.closer.meetingComments.addComment);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(ENTER_BEHAVIOR_KEY) as EnterBehavior | null;
      if (stored === "send" || stored === "newline") setEnterBehavior(stored);
    } catch {}
  }, []);

  const toggleEnterBehavior = useCallback(() => {
    setEnterBehavior((prev) => {
      const next: EnterBehavior = prev === "send" ? "newline" : "send";
      try { localStorage.setItem(ENTER_BEHAVIOR_KEY, next); } catch {}
      return next;
    });
  }, []);

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
      if (e.key !== "Enter") return;
      const shouldSend =
        enterBehavior === "send" ? !e.shiftKey : e.shiftKey;
      if (shouldSend) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [enterBehavior, handleSubmit],
  );

  const placeholder =
    enterBehavior === "send"
      ? "Add a comment… (Enter to send, Shift+Enter for newline)"
      : "Add a comment… (Shift+Enter to send, Enter for newline)";

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-2">
        <Textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="min-h-[72px] resize-none text-sm"
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
      <div className="flex justify-end">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={toggleEnterBehavior}
              className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <CornerDownLeftIcon className="size-3" />
              Enter: {enterBehavior === "send" ? "sends" : "newline"}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-[200px] text-center text-xs">
            {enterBehavior === "send"
              ? "Click to switch: Enter will insert a newline (Shift+Enter to send)"
              : "Click to switch: Enter will send (Shift+Enter for newline)"}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
