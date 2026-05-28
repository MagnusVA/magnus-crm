"use client";

import { useMemo, useState } from "react";
import type { DateRange } from "react-day-picker";
import { CalendarIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useIsMobile } from "@/hooks/use-mobile";
import {
	businessDateToCalendarDate,
	calendarDateToBusinessDate,
	validateCustomDashboardRange,
} from "./dashboard-date-utils";

export type DashboardRangeInput =
	| { kind: "preset"; preset: "today" | "this_week" | "this_month" }
	| {
			kind: "custom";
			startBusinessDate: string;
			endBusinessDateInclusive: string;
	  };

type Props = {
	value: DashboardRangeInput;
	onChange: (value: DashboardRangeInput) => void;
	validationMessage: string | null;
};

export function DashboardDateRangeFilter({
	value,
	onChange,
	validationMessage,
}: Props) {
	const isMobile = useIsMobile();
	const [open, setOpen] = useState(false);
	const [draftRange, setDraftRange] = useState<DateRange | undefined>(() =>
		value.kind === "custom"
			? {
					from: businessDateToCalendarDate(value.startBusinessDate),
					to: businessDateToCalendarDate(value.endBusinessDateInclusive),
				}
			: undefined,
	);
	const presetValue = value.kind === "preset" ? value.preset : "custom";
	const draftBusinessRange = useMemo(
		() => ({
			startBusinessDate: draftRange?.from
				? calendarDateToBusinessDate(draftRange.from)
				: undefined,
			endBusinessDateInclusive: draftRange?.to
				? calendarDateToBusinessDate(draftRange.to)
				: undefined,
		}),
		[draftRange],
	);
	const draftError = validateCustomDashboardRange(draftBusinessRange);

	return (
		<div className="flex min-w-0 flex-col items-start gap-2 sm:items-end">
			<div className="flex min-w-0 flex-wrap items-center gap-2">
				<ToggleGroup
					type="single"
					value={presetValue}
					onValueChange={(next) => {
						if (
							next === "today" ||
							next === "this_week" ||
							next === "this_month"
						) {
							onChange({ kind: "preset", preset: next });
						}
					}}
					variant="outline"
					size="sm"
					aria-label="Dashboard range"
				>
					<ToggleGroupItem value="today" aria-label="Day">
						Day
					</ToggleGroupItem>
					<ToggleGroupItem value="this_week" aria-label="Week">
						Week
					</ToggleGroupItem>
					<ToggleGroupItem value="this_month" aria-label="Month">
						Month
					</ToggleGroupItem>
				</ToggleGroup>

				<Popover open={open} onOpenChange={setOpen}>
					<PopoverTrigger asChild>
						<Button
							variant={presetValue === "custom" ? "default" : "outline"}
							size="sm"
						>
							<CalendarIcon data-icon="inline-start" aria-hidden="true" />
							Custom
						</Button>
					</PopoverTrigger>
					<PopoverContent
						align="end"
						className="w-[calc(100vw-2rem)] max-w-fit p-2"
					>
						<Calendar
							mode="range"
							selected={draftRange}
							onSelect={setDraftRange}
							numberOfMonths={isMobile ? 1 : 2}
						/>
						<div className="flex items-center justify-between gap-3 border-t px-2 pt-2">
							<p className="min-w-0 text-xs text-muted-foreground">
								{draftError ?? "Range ready."}
							</p>
							<Button
								size="sm"
								disabled={draftError !== null}
								onClick={() => {
									if (
										!draftBusinessRange.startBusinessDate ||
										!draftBusinessRange.endBusinessDateInclusive
									) {
										return;
									}
									onChange({
										kind: "custom",
										startBusinessDate: draftBusinessRange.startBusinessDate,
										endBusinessDateInclusive:
											draftBusinessRange.endBusinessDateInclusive,
									});
									setOpen(false);
								}}
							>
								Apply
							</Button>
						</div>
					</PopoverContent>
				</Popover>
			</div>
			{validationMessage ? (
				<p className="text-xs text-destructive">{validationMessage}</p>
			) : null}
		</div>
	);
}
