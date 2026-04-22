"use client";

import { InfoIcon } from "lucide-react";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";

const ALL_SENTINEL = "__all__";

type RevenueSlice = "commissionable" | "non_commissionable";

interface ReportRevenueSliceFilterProps {
	value?: RevenueSlice;
	onChange: (next: RevenueSlice | undefined) => void;
	disabled?: boolean;
}

/**
 * Shared "Revenue Slice" filter — slices payments by attribution scope.
 * Commissionable payments are attributed to a closer (from meeting / reminder /
 * review-resolution flows). Post-conversion payments are logged by admins
 * against a customer after their deal closed and are not attributed.
 */
export function ReportRevenueSliceFilter({
	value,
	onChange,
	disabled,
}: ReportRevenueSliceFilterProps) {
	return (
		<div className="flex items-center gap-1">
			<Select
				value={value ?? ALL_SENTINEL}
				onValueChange={(next) => {
					if (next === ALL_SENTINEL) {
						onChange(undefined);
					} else {
						onChange(next as RevenueSlice);
					}
				}}
				disabled={disabled}
			>
				<SelectTrigger
					className="w-[200px]"
					aria-label="Filter by revenue slice"
				>
					<SelectValue placeholder="Revenue Slice" />
				</SelectTrigger>
				<SelectContent>
					<SelectGroup>
						<SelectLabel>Revenue Slice</SelectLabel>
						<SelectItem value={ALL_SENTINEL}>All Revenue</SelectItem>
						<SelectItem value="commissionable">Commissionable</SelectItem>
						<SelectItem value="non_commissionable">
							Post-Conversion
						</SelectItem>
					</SelectGroup>
				</SelectContent>
			</Select>

			<Popover>
				<PopoverTrigger asChild>
					<Button
						type="button"
						variant="ghost"
						size="icon"
						className="size-7"
						aria-label="What is revenue slice?"
					>
						<InfoIcon className="size-4 text-muted-foreground" />
					</Button>
				</PopoverTrigger>
				<PopoverContent className="w-80 text-sm" align="start">
					<p>
						<strong>Commissionable</strong> revenue is attributed to a closer
						(earned from a meeting, reminder, or review-resolution flow).
					</p>
					<p className="mt-2">
						<strong>Post-Conversion</strong> revenue is logged by admins against
						a customer after their deal closed and is not attributed to any
						closer.
					</p>
				</PopoverContent>
			</Popover>
		</div>
	);
}

export type { RevenueSlice };
