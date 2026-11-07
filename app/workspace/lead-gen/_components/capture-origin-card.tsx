"use client";

import { ExternalLinkIcon, LinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { CARD, LABEL } from "@/app/workspace/team/_components/team-ui";
import { cn } from "@/lib/utils";

// Capture's Origin card (Instagram only). While choosing: the post or reel
// URL, detected as it's pasted, and the four origins that have no link.
// Once chosen: one 44px row with the origin and Change.

export type NonRankableInstagramOrigin = "story_poll" | "story" | "follower" | "application";

export type ChosenOrigin =
  | { kind: "post" | "reel"; originUrl: string; shortcode: string; detectedFromUrl: true }
  | { kind: NonRankableInstagramOrigin; detectedFromUrl: false };

export const NON_RANKABLE_ORIGINS: ReadonlyArray<{ value: NonRankableInstagramOrigin; label: string }> = [
  { value: "story_poll", label: "Story poll" },
  { value: "story", label: "Story" },
  { value: "follower", label: "Follower" },
  { value: "application", label: "Application" },
];

export const ORIGIN_URL_INPUT_ID = "lead-gen-origin-url";
const ORIGIN_ERROR_ID = "lead-gen-origin-url-error";

export function OriginChooser({
  draft,
  disabled,
  showError,
  onDraftChange,
  onBlur,
  onPick,
}: {
  draft: string;
  disabled: boolean;
  showError: boolean;
  onDraftChange: (value: string) => void;
  onBlur: () => void;
  onPick: (kind: NonRankableInstagramOrigin) => void;
}) {
  return (
    <section aria-labelledby="capture-origin-title" className={CARD}>
      <div className="flex min-h-11 items-center border-b border-border px-4 py-2">
        <h2 id="capture-origin-title" className="text-[15px] font-semibold">
          Origin
        </h2>
      </div>
      <div className="flex flex-col gap-3 px-4 py-3.5">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ORIGIN_URL_INPUT_ID} className="sr-only">
            Post or reel URL
          </label>
          <InputGroup className="h-11">
            <InputGroupAddon>
              <LinkIcon aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              id={ORIGIN_URL_INPUT_ID}
              aria-invalid={showError}
              aria-describedby={showError ? ORIGIN_ERROR_ID : undefined}
              autoCapitalize="none"
              autoComplete="off"
              autoCorrect="off"
              disabled={disabled}
              inputMode="url"
              onBlur={onBlur}
              onChange={(event) => onDraftChange(event.target.value)}
              placeholder="Paste a post or reel URL"
              spellCheck={false}
              type="text"
              value={draft}
              className="text-[15px]"
            />
          </InputGroup>
          {showError ? (
            <p id={ORIGIN_ERROR_ID} className="text-[13px] text-danger-ink">
              Enter an Instagram post or reel URL.
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <p id="capture-origin-pick" className="text-[13px] text-muted-foreground">
            Or pick one without a link
          </p>
          <div role="group" aria-labelledby="capture-origin-pick" className="grid grid-cols-2 gap-2 @md:grid-cols-4">
            {NON_RANKABLE_ORIGINS.map((option) => (
              <Button
                key={option.value}
                type="button"
                variant="outline"
                disabled={disabled}
                onClick={() => onPick(option.value)}
                className="h-8 min-w-0"
              >
                <span className="truncate">{option.label}</span>
              </Button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/** The chosen origin as one 44px row: ORIGIN, the value, and Change. */
export function OriginChosen({
  origin,
  disabled,
  onChange,
}: {
  origin: ChosenOrigin;
  disabled: boolean;
  onChange: () => void;
}) {
  return (
    <section aria-label="Origin" className={cn(CARD, "flex min-h-11 items-center gap-3 px-4 py-1.5")}>
      <span className={LABEL}>Origin</span>
      {origin.detectedFromUrl ? (
        <a
          href={origin.originUrl}
          target="_blank"
          rel="noreferrer"
          title={origin.originUrl}
          className="inline-flex min-w-0 items-center gap-1.5 rounded-sm font-medium underline decoration-foreground/40 underline-offset-[3px] outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="truncate">
            {origin.kind === "reel" ? "Reel" : "Post"} · <span translate="no">{origin.shortcode}</span>
          </span>
          <ExternalLinkIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      ) : (
        <span className="min-w-0 truncate font-medium">
          {NON_RANKABLE_ORIGINS.find((option) => option.value === origin.kind)?.label ?? "Origin"}
        </span>
      )}
      <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={onChange} className="ml-auto h-7 shrink-0">
        Change
      </Button>
    </section>
  );
}
