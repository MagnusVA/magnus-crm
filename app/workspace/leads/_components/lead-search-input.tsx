"use client";

import { useRef, useCallback, useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { SearchIcon, XIcon } from "lucide-react";

interface LeadSearchInputProps {
	value: string;
	onChange: (term: string) => void;
}

/**
 * Debounced search input for the lead list and merge target search.
 *
 * - 300ms debounce delay prevents excessive Convex queries on fast typing
 * - Local state keeps the input responsive while the debounced value propagates
 * - Clear button (XIcon) resets both local and parent state instantly
 */
export function LeadSearchInput({ value, onChange }: LeadSearchInputProps) {
	const [localValue, setLocalValue] = useState(value);
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const handleChange = useCallback(
		(newValue: string) => {
			setLocalValue(newValue);
			if (debounceRef.current) clearTimeout(debounceRef.current);
			debounceRef.current = setTimeout(() => {
				onChange(newValue);
			}, 300);
		},
		[onChange],
	);

	// Sync external value changes (e.g., programmatic reset)
	useEffect(() => {
		setLocalValue(value);
	}, [value]);

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			if (debounceRef.current) clearTimeout(debounceRef.current);
		};
	}, []);

	return (
		<div className="relative w-full sm:max-w-xs">
			<SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
			<Input
				value={localValue}
				onChange={(e) => handleChange(e.target.value)}
				placeholder="Search by name, email, phone, or social..."
				className="pl-9 pr-8"
			/>
			{localValue.length > 0 && (
				<button
					type="button"
					onClick={() => handleChange("")}
					className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
					aria-label="Clear search"
				>
					<XIcon className="h-4 w-4" />
				</button>
			)}
		</div>
	);
}
