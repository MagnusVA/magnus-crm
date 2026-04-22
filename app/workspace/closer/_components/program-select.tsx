"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

type ProgramSelectProps = {
	/** Current selection, or undefined for "not yet chosen". */
	value: string | undefined;
	/** Called with the raw tenantPrograms Id string. Caller casts to Id<"tenantPrograms">. */
	onChange: (value: string) => void;
	/** Disable the entire control (submit in flight, etc.). */
	disabled?: boolean;
	/** Override the default placeholder. */
	placeholder?: string;
	/** Additional CSS classes for the outer wrapper. */
	className?: string;
};

/**
 * Shared tenant-program dropdown used by every commissionable and
 * customer-direct payment dialog. Owns three states so callers never
 * branch on loading / empty.
 *
 * - `programs === undefined` → loading pill with spinner.
 * - `programs.length === 0` → muted empty-state hint.
 * - `programs.length > 0` → populated shadcn `<Select>`.
 *
 * Consumers pass `value: string | undefined` and cast at their mutation
 * boundary — the component itself stays generic to match RHF field typing.
 */
export function ProgramSelect({
	value,
	onChange,
	disabled,
	placeholder,
	className,
}: ProgramSelectProps) {
	const programs = useQuery(api.tenantPrograms.queries.listPrograms, {
		includeArchived: false,
	});

	if (programs === undefined) {
		return (
			<div
				className={cn(
					"flex h-9 items-center gap-2 rounded-md border border-input bg-transparent px-3 text-sm text-muted-foreground",
					className,
				)}
				role="status"
				aria-label="Loading programs"
			>
				<Spinner className="size-3" />
				<span>Loading programs…</span>
			</div>
		);
	}

	if (programs.length === 0) {
		return (
			<p
				className={cn("text-xs text-muted-foreground", className)}
				role="alert"
			>
				No programs configured yet. Ask an admin to add one in{" "}
				<strong>Settings → Programs</strong>.
			</p>
		);
	}

	return (
		<Select value={value} onValueChange={onChange} disabled={disabled}>
			<SelectTrigger className={className} aria-label="Select program">
				<SelectValue placeholder={placeholder ?? "Select a program"} />
			</SelectTrigger>
			<SelectContent>
				{programs.map((program) => (
					<SelectItem key={program._id} value={program._id}>
						{program.name}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
