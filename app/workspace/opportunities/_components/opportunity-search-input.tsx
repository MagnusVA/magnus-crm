"use client";

import { useEffect, useState } from "react";
import { SearchIcon } from "lucide-react";
import { Input } from "@/components/ui/input";

type OpportunitySearchInputProps = {
  value: string;
  onChange: (value: string) => void;
};

export function OpportunitySearchInput({
  value,
  onChange,
}: OpportunitySearchInputProps) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(() => {
    const timeout = window.setTimeout(() => onChange(draft), 300);
    return () => window.clearTimeout(timeout);
  }, [draft, onChange]);

  return (
    <div className="relative w-full lg:max-w-md">
      <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="Search lead name, email, or phone…"
        className="pl-9"
      />
    </div>
  );
}
