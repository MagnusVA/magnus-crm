"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";

export function CloserSelect({
	id,
	value,
	onChange,
	disabled,
	invalid,
}: {
	id?: string;
	invalid?: boolean;
	value?: Id<"users">;
	onChange: (value: Id<"users"> | undefined) => void;
	disabled?: boolean;
}) {
	const closers = useQuery(api.users.queries.listActiveClosers, {});

	return (
		<Select
			value={value ?? ""}
			onValueChange={(next) => onChange(next as Id<"users">)}
			disabled={disabled || closers === undefined}
		>
			<SelectTrigger id={id} aria-invalid={invalid || undefined} className="w-full">
				<SelectValue
					placeholder={
						closers === undefined ? "Loading closers…" : "Pick a closer"
					}
				/>
			</SelectTrigger>
			<SelectContent>
				<SelectGroup>
					{closers?.map((closer) => (
						<SelectItem key={closer._id} value={closer._id}>
							{closer.fullName ?? closer.email}
						</SelectItem>
					))}
				</SelectGroup>
			</SelectContent>
		</Select>
	);
}
