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
	value,
	onChange,
	disabled,
}: {
	value?: Id<"users">;
	onChange: (value: Id<"users"> | undefined) => void;
	disabled?: boolean;
}) {
	const closers = useQuery(api.users.queries.listActiveClosers, {});

	return (
		<Select
			value={value}
			onValueChange={(next) => onChange(next as Id<"users">)}
			disabled={disabled || closers === undefined}
		>
			<SelectTrigger className="w-full">
				<SelectValue
					placeholder={
						closers === undefined ? "Loading closers" : "Select closer"
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
