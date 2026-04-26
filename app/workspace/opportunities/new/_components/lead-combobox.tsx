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

type LeadPickerValue = {
	_id: Id<"leads">;
	fullName?: string;
	email?: string;
	phone?: string;
	status: string;
};

function getLeadLabel(lead: LeadPickerValue) {
	return lead.fullName?.trim() || lead.email || lead.phone || "Unnamed lead";
}

export function LeadCombobox({
	value,
	onChange,
	disabled,
}: {
	value?: Id<"leads">;
	onChange: (value: Id<"leads"> | undefined) => void;
	disabled?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [draft, setDraft] = useState("");
	const [debounced, setDebounced] = useState("");

	useEffect(() => {
		const timeout = window.setTimeout(() => setDebounced(draft), 300);
		return () => window.clearTimeout(timeout);
	}, [draft]);

	const selectedLead = useQuery(
		api.leads.queries.getLeadForPicker,
		value ? { leadId: value } : "skip",
	);
	const trimmedSearch = debounced.trim();
	const results = useQuery(
		api.leads.queries.searchLeadsForPicker,
		trimmedSearch.length >= 2 ? { searchTerm: trimmedSearch } : "skip",
	);

	useEffect(() => {
		if (value && selectedLead === null) {
			onChange(undefined);
		}
	}, [onChange, selectedLead, value]);

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					variant="outline"
					role="combobox"
					aria-expanded={open}
					className="w-full min-w-0 justify-between"
					disabled={disabled}
				>
					<span className="min-w-0 truncate text-left">
						{selectedLead ? (
							<>
								{getLeadLabel(selectedLead)}
								{selectedLead.email ? (
									<span className="ml-2 text-muted-foreground">
										{selectedLead.email}
									</span>
								) : null}
							</>
						) : value ? (
							<span className="text-muted-foreground">Loading selected lead…</span>
						) : (
							<span className="text-muted-foreground">
								Search leads by name, email, or phone…
							</span>
						)}
					</span>
					<ChevronsUpDownIcon data-icon="inline-end" />
				</Button>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className="w-[--radix-popover-trigger-width] p-0"
			>
				<Command shouldFilter={false}>
					<CommandInput
						placeholder="Search leads…"
						value={draft}
						onValueChange={setDraft}
					/>
					<CommandList>
						{trimmedSearch.length < 2 ? (
							<CommandEmpty>Type at least 2 characters.</CommandEmpty>
						) : null}
						{trimmedSearch.length >= 2 && results === undefined ? (
							<CommandEmpty>Searching leads…</CommandEmpty>
						) : null}
						{trimmedSearch.length >= 2 && results?.length === 0 ? (
							<CommandEmpty>No leads found. Switch to New lead.</CommandEmpty>
						) : null}
						{results && results.length > 0 ? (
							<CommandGroup>
								{results.map((lead) => (
									<CommandItem
										key={lead._id}
										value={lead._id}
										onSelect={() => {
											onChange(lead._id);
											setOpen(false);
										}}
									>
										<CheckIcon
											className={cn(
												value === lead._id ? "opacity-100" : "opacity-0",
											)}
										/>
										<div className="flex min-w-0 flex-col">
											<span className="truncate font-medium">
												{getLeadLabel(lead)}
											</span>
											<span className="truncate text-xs text-muted-foreground">
												{[lead.email, lead.phone, lead.status]
													.filter(Boolean)
													.join(" - ")}
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
