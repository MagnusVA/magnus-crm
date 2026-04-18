"use client";

import { Fragment } from "react";

const URL_REGEX = /(?:https?:\/\/|www\.)[^\s<>)"'\]]+/gi;

type CommentContentProps = {
  content: string;
};

export function CommentContent({ content }: CommentContentProps) {
  const parts: Array<{ type: "text" | "link"; value: string }> = [];
  let lastIndex = 0;

  for (const match of content.matchAll(URL_REGEX)) {
    const matchIndex = match.index!;
    if (matchIndex > lastIndex) {
      parts.push({
        type: "text",
        value: content.slice(lastIndex, matchIndex),
      });
    }
    const url = match[0];
    parts.push({ type: "link", value: url });
    lastIndex = matchIndex + url.length;
  }

  if (lastIndex < content.length) {
    parts.push({ type: "text", value: content.slice(lastIndex) });
  }

  if (parts.length === 0) {
    return (
      <p className="whitespace-pre-wrap text-sm text-foreground">{content}</p>
    );
  }

  return (
    <p className="whitespace-pre-wrap text-sm text-foreground">
      {parts.map((part, i) =>
        part.type === "link" ? (
          <a
            key={i}
            href={
              part.value.startsWith("http")
                ? part.value
                : `https://${part.value}`
            }
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline underline-offset-2 break-all hover:text-primary/80"
          >
            {part.value}
          </a>
        ) : (
          <Fragment key={i}>{part.value}</Fragment>
        ),
      )}
    </p>
  );
}
