"use client";

import { TableHead } from "@/components/ui/table";
import { ChevronUpIcon, ChevronDownIcon, ChevronsUpDownIcon } from "lucide-react";
import type { SortState } from "@/hooks/use-table-sort";

interface SortableHeaderProps<K extends string> {
  label: string;
  sortKey: K;
  sort: SortState<K>;
  onToggle: (key: K) => void;
  className?: string;
}

export function SortableHeader<K extends string>({
  label,
  sortKey,
  sort,
  onToggle,
  className,
}: SortableHeaderProps<K>) {
  const isActive = sort.key === sortKey;
  return (
    <TableHead className={className}>
      <button
        className="flex items-center gap-1 text-left font-semibold"
        onClick={() => onToggle(sortKey)}
        aria-sort={isActive ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
      >
        {label}
        {isActive && sort.direction === "asc" && <ChevronUpIcon className="size-3" />}
        {isActive && sort.direction === "desc" && <ChevronDownIcon className="size-3" />}
        {!isActive && <ChevronsUpDownIcon className="size-3 text-muted-foreground/40" />}
      </button>
    </TableHead>
  );
}
