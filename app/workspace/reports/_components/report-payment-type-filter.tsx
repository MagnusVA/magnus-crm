"use client";

import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { BAND_SELECT } from "./report-ui";

const ALL_SENTINEL = "__all__";

type PaymentType = "pif" | "split" | "monthly" | "deposit";

const PAYMENT_TYPE_OPTIONS: Array<{ value: PaymentType; label: string }> = [
	{ value: "pif", label: "PIF (Paid in Full)" },
	{ value: "split", label: "Split Payment" },
	{ value: "monthly", label: "Monthly" },
	{ value: "deposit", label: "Deposit" },
];

interface ReportPaymentTypeFilterProps {
	value?: PaymentType;
	onChange: (next: PaymentType | undefined) => void;
	disabled?: boolean;
}

/**
 * Shared "Payment Type" filter — stateless, four literal options. Used across
 * Revenue, Reminders, and Activity Feed reports.
 */
export function ReportPaymentTypeFilter({
	value,
	onChange,
	disabled,
}: ReportPaymentTypeFilterProps) {
	return (
		<Select
			value={value ?? ALL_SENTINEL}
			onValueChange={(next) => {
				if (next === ALL_SENTINEL) {
					onChange(undefined);
				} else {
					onChange(next as PaymentType);
				}
			}}
			disabled={disabled}
		>
			<SelectTrigger
				className={cn(BAND_SELECT, "w-[164px] max-w-full")}
				aria-label="Filter by payment type"
			>
				<SelectValue placeholder="Payment Type" />
			</SelectTrigger>
			<SelectContent>
				<SelectGroup>
					<SelectLabel>Payment Type</SelectLabel>
					<SelectItem value={ALL_SENTINEL}>All Payment Types</SelectItem>
					{PAYMENT_TYPE_OPTIONS.map((opt) => (
						<SelectItem key={opt.value} value={opt.value}>
							{opt.label}
						</SelectItem>
					))}
				</SelectGroup>
			</SelectContent>
		</Select>
	);
}

export type { PaymentType };
