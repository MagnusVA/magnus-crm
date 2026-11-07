"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { getErrorMessage } from "@/lib/errors";
import { reportClientError } from "@/lib/observability/report-client-error";
import { MAX_DAILY_GOAL } from "./goal-model";

/**
 * A daily goal's number, always editable: Enter or leaving the field saves,
 * Escape puts the saved value back, and a blank field means no goal. The save
 * shows an Undo toast that restores the value it replaced.
 */
export function GoalInput({
  value,
  label,
  what,
  save,
  flow,
}: {
  /** The saved goal; null = no goal. */
  value: number | null;
  /** The input's accessible name: "Qualified leads a day". */
  label: string;
  /** For the toast: (next) => "Qualified leads goal: 70 a day". */
  what: (next: number | null) => string;
  save: (next: number | null) => Promise<unknown>;
  /** reportClientError's flow name. */
  flow: string;
}) {
  const saved = value === null ? "" : String(value);
  const [draft, setDraft] = useState(saved);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const cancelled = useRef(false);
  // While the field isn't being edited it follows the saved value (an Undo, another admin).
  const shown = editing ? draft : saved;

  async function commit() {
    const raw = draft.trim();
    const next = raw === "" ? null : Number(raw);
    if (next !== null && (!Number.isInteger(next) || next < 0 || next > MAX_DAILY_GOAL)) {
      toast.error(`Enter a whole number from 0 to ${MAX_DAILY_GOAL}, or leave it blank for no goal.`);
      setEditing(false);
      return;
    }
    const previous = value;
    if (next === previous) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await save(next);
      toast.success(what(next), {
        action: {
          label: "Undo",
          onClick: () => {
            save(previous).catch((error: unknown) => {
              reportClientError(error, { flow: `${flow}_undo` });
              toast.error(getErrorMessage(error, "Couldn’t undo that change."));
            });
          },
        },
      });
    } catch (error) {
      reportClientError(error, { flow });
      toast.error(getErrorMessage(error, "Couldn’t save the goal."));
    } finally {
      setSaving(false);
      setEditing(false);
    }
  }

  return (
    <span className="flex items-center gap-2">
      <Input
        value={shown}
        inputMode="numeric"
        placeholder="—"
        aria-label={label}
        disabled={saving}
        onFocus={() => {
          cancelled.current = false;
          setDraft(saved);
          setEditing(true);
        }}
        onChange={(event) => {
          setDraft(event.target.value);
          setEditing(true);
        }}
        onBlur={() => {
          if (cancelled.current) {
            cancelled.current = false;
            setEditing(false);
          } else void commit();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            event.preventDefault();
            cancelled.current = true;
            event.currentTarget.blur();
          }
        }}
        className="h-9 w-[76px] text-center font-condensed text-[17px] font-semibold tabular-nums"
      />
      <span className="min-w-[46px] text-[12.5px] leading-tight whitespace-nowrap text-muted-foreground">
        {value === null && !editing ? "No goal" : "a day"}
      </span>
    </span>
  );
}
