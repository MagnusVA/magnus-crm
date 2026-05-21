"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";

const ALL_SENTINEL = "__all__";

interface ReportProgramFilterProps {
	value?: Id<"tenantPrograms">;
	onChange: (next: Id<"tenantPrograms"> | undefined) => void;
	disabled?: boolean;
	label?: string;
}

/**
 * Shared program-dimension filter used across Revenue, Reminders, and Activity Feed
 * reports. Fetches active + archived programs (reporting surfaces archived
 * programs per design §2.6 so historical slices remain accessible); caller
 * receives `undefined` when the user selects the all-programs option.
 */
export function ReportProgramFilter({
	value,
	onChange,
	disabled,
	label = "Payment program",
}: ReportProgramFilterProps) {
	const programs = useQuery(api.tenantPrograms.queries.listPrograms, {
		includeArchived: true,
	});

	// Hide the filter entirely when the tenant has no programs (onboarding edge case).
	if (programs !== undefined && programs.length === 0) {
		return null;
	}

	const isLoading = programs === undefined;
	const activePrograms =
		programs?.filter((p) => p.archivedAt === undefined) ?? [];
	const archivedPrograms =
		programs?.filter((p) => p.archivedAt !== undefined) ?? [];
	const allLabel = `All ${label.toLowerCase()}s`;

	return (
		<Select
			value={value ?? ALL_SENTINEL}
			onValueChange={(next) => {
				if (next === ALL_SENTINEL) {
					onChange(undefined);
				} else {
					onChange(next as Id<"tenantPrograms">);
				}
			}}
			disabled={disabled || isLoading}
		>
			<SelectTrigger className="w-[200px]" aria-label={label}>
				<SelectValue placeholder={label} />
				{isLoading ? <Spinner className="ml-2 size-3" /> : null}
			</SelectTrigger>
			<SelectContent>
				<SelectGroup>
					<SelectLabel>{label}</SelectLabel>
					<SelectItem value={ALL_SENTINEL}>{allLabel}</SelectItem>
				</SelectGroup>
				{activePrograms.length > 0 ? (
					<SelectGroup>
						<SelectLabel>Active</SelectLabel>
						{activePrograms.map((program) => (
							<SelectItem key={program._id} value={program._id}>
								{program.name}
							</SelectItem>
						))}
					</SelectGroup>
				) : null}
				{archivedPrograms.length > 0 ? (
					<SelectGroup>
						<SelectLabel>Archived</SelectLabel>
						{archivedPrograms.map((program) => (
							<SelectItem key={program._id} value={program._id}>
								{program.name}{" "}
								<span className="ml-1 text-muted-foreground">
									(archived)
								</span>
							</SelectItem>
						))}
					</SelectGroup>
				) : null}
			</SelectContent>
		</Select>
	);
}
