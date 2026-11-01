"use client";

import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { CheckIcon, ChevronsUpDownIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

type PersonPickerValue = {
	_id: Id<"leads">;
	fullName?: string;
	email?: string;
	phone?: string;
	status: string;
};

function personLabel(person: PersonPickerValue) {
	return person.fullName?.trim() || person.email || person.phone || "Unnamed person";
}

/** Search the tenant's people and pick one; the field's value is its id. */
export function LeadCombobox({
	id,
	value,
	onChange,
	disabled,
	invalid,
}: {
	id?: string;
	value?: Id<"leads">;
	onChange: (value: Id<"leads"> | undefined) => void;
	disabled?: boolean;
	invalid?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [draft, setDraft] = useState("");
	const [debounced, setDebounced] = useState("");

	useEffect(() => {
		const timeout = window.setTimeout(() => setDebounced(draft), 300);
		return () => window.clearTimeout(timeout);
	}, [draft]);

	const selected = useQuery(
		api.leads.queries.getLeadForPicker,
		value ? { leadId: value } : "skip",
	);
	const trimmedSearch = debounced.trim();
	const results = useQuery(
		api.leads.queries.searchLeadsForPicker,
		trimmedSearch.length >= 2 ? { searchTerm: trimmedSearch } : "skip",
	);

	useEffect(() => {
		if (value && selected === null) {
			onChange(undefined);
		}
	}, [onChange, selected, value]);

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					id={id}
					variant="outline"
					role="combobox"
					aria-expanded={open}
					aria-invalid={invalid || undefined}
					className="w-full min-w-0 justify-between border-input bg-transparent font-normal dark:bg-input/30"
					disabled={disabled}
				>
					<span className="min-w-0 truncate text-left">
						{selected ? (
							<>
								<span className="font-medium" translate="no">
									{personLabel(selected)}
								</span>
								{selected.email ? (
									<span className="ml-2 text-[13px] text-muted-foreground" translate="no">
										{selected.email}
									</span>
								) : null}
							</>
						) : value ? (
							<span className="text-muted-foreground">Loading the person…</span>
						) : (
							<span className="text-muted-foreground">
								Search people by name, email or phone…
							</span>
						)}
					</span>
					<ChevronsUpDownIcon data-icon="inline-end" className="text-muted-foreground" />
				</Button>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className="w-(--radix-popover-trigger-width) p-0"
			>
				<Command shouldFilter={false}>
					<CommandInput
						placeholder="Search people…"
						value={draft}
						onValueChange={setDraft}
					/>
					<CommandList>
						{trimmedSearch.length < 2 ? (
							<CommandEmpty>Type at least 2 characters.</CommandEmpty>
						) : null}
						{trimmedSearch.length >= 2 && results === undefined ? (
							<CommandEmpty>Searching…</CommandEmpty>
						) : null}
						{trimmedSearch.length >= 2 && results?.length === 0 ? (
							<CommandEmpty>
								Nobody matches. Switch to New to add the person.
							</CommandEmpty>
						) : null}
						{results && results.length > 0 ? (
							<CommandGroup>
								{results.map((person) => (
									<CommandItem
										key={person._id}
										value={person._id}
										onSelect={() => {
											onChange(person._id);
											setOpen(false);
										}}
									>
										<CheckIcon
											className={cn(
												value === person._id ? "opacity-100" : "opacity-0",
											)}
										/>
										<div className="flex min-w-0 flex-col">
											<span className="truncate font-medium" translate="no">
												{personLabel(person)}
											</span>
											<span className="truncate text-xs text-muted-foreground" translate="no">
												{[
													person.email,
													person.phone,
													person.status === "converted" ? "Customer" : null,
												]
													.filter(Boolean)
													.join(" · ")}
											</span>
										</div>
									</CommandItem>
								))}
							</CommandGroup>
						) : null}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}
