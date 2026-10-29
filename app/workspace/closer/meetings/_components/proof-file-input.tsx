"use client";

import { useRef } from "react";
import { PaperclipIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ProofFileInputProps = {
  value: File | undefined;
  onChange: (file: File | undefined) => void;
  onBlur?: () => void;
  name?: string;
  accept: string;
  disabled?: boolean;
  className?: string;
} & Pick<
  React.ComponentProps<"button">,
  "id" | "aria-describedby" | "aria-invalid"
>;

/**
 * A file picker that looks like the rest of the form: a button opens the
 * hidden native input, and the chosen file shows its name, size and a remove
 * action. Inside `FormControl`, the label, description and error attach to
 * the button.
 */
export function ProofFileInput({
  value,
  onChange,
  onBlur,
  name,
  accept,
  disabled,
  className,
  ...buttonProps
}: ProofFileInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const clear = () => {
    onChange(undefined);
    // So choosing the same file again still fires a change.
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      <input
        ref={inputRef}
        type="file"
        name={name}
        accept={accept}
        disabled={disabled}
        hidden
        tabIndex={-1}
        onChange={(event) => onChange(event.target.files?.[0])}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        onBlur={onBlur}
        {...buttonProps}
      >
        <PaperclipIcon data-icon="inline-start" />
        {value ? "Replace file" : "Attach file"}
      </Button>
      {value ? (
        <span className="flex min-w-0 items-center gap-1 rounded-md border bg-muted/50 py-0.5 pr-0.5 pl-2 text-[0.8125rem]">
          <span className="truncate font-medium">{value.name}</span>
          <span className="shrink-0 text-muted-foreground tabular-nums">
            {(value.size / 1024).toFixed(1)} KB
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={disabled}
            onClick={clear}
            aria-label={`Remove ${value.name}`}
            className="text-muted-foreground"
          >
            <XIcon />
          </Button>
        </span>
      ) : (
        <span className="text-[0.8125rem] text-muted-foreground">No file attached</span>
      )}
    </div>
  );
}
