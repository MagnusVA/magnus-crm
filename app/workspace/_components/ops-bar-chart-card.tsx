"use client";

import { useMemo } from "react";
import { ChartBarIcon } from "lucide-react";
import {
	Bar,
	BarChart,
	CartesianGrid,
	LabelList,
	XAxis,
	YAxis,
} from "recharts";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
	type ChartConfig,
} from "@/components/ui/chart";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { formatWholeNumber } from "./overview-formatters";

const MAX_VISIBLE_BARS = 12;
const BAR_ROW_HEIGHT = 44;
const MIN_CHART_HEIGHT = 140;
const Y_AXIS_TICK_MAX_CHARS = 16;

export type OpsBarChartDatum = {
	/** Stable identity for the row (e.g. a document id). */
	key: string;
	/** Person name shown on the Y axis. */
	label: string;
	value: number;
};

export type OpsBarChartCardProps = {
	title: string;
	description?: string;
	/** Pre-sorted rows; only the first 12 render, the rest fold into "+N more". */
	data: OpsBarChartDatum[];
	/** Metric name shown in the tooltip, e.g. "Qualified leads". */
	valueLabel: string;
	loading?: boolean;
	emptyMessage?: string;
	className?: string;
};

function OpsBarChartSkeleton({ title }: { title: string }) {
	return (
		<div
			className="flex flex-col gap-3"
			role="status"
			aria-label={`Loading ${title}`}
		>
			<Skeleton className="h-6 w-3/4" />
			<Skeleton className="h-6 w-full" />
			<Skeleton className="h-6 w-1/2" />
			<Skeleton className="h-6 w-2/3" />
			<Skeleton className="h-6 w-1/3" />
		</div>
	);
}

/**
 * Horizontal per-person bar chart card in the shadcn bar chart block style —
 * used for "per opener" / "per D-Closer" breakdowns on the operations pages.
 */
export function OpsBarChartCard({
	title,
	description,
	data,
	valueLabel,
	loading = false,
	emptyMessage,
	className,
}: OpsBarChartCardProps) {
	const visibleData = useMemo(() => data.slice(0, MAX_VISIBLE_BARS), [data]);
	const hiddenCount = data.length - visibleData.length;
	const chartHeight = Math.max(
		MIN_CHART_HEIGHT,
		visibleData.length * BAR_ROW_HEIGHT,
	);

	const chartConfig = useMemo<ChartConfig>(
		() => ({
			value: {
				label: valueLabel,
				color: "var(--chart-1)",
			},
		}),
		[valueLabel],
	);

	return (
		<Card className={className}>
			<CardHeader>
				<CardTitle>{title}</CardTitle>
				{description ? <CardDescription>{description}</CardDescription> : null}
			</CardHeader>
			<CardContent>
				{loading ? (
					<OpsBarChartSkeleton title={title} />
				) : visibleData.length === 0 ? (
					<Empty className="min-h-[160px] border p-4">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<ChartBarIcon aria-hidden="true" />
							</EmptyMedia>
							<EmptyTitle>Nothing to chart</EmptyTitle>
							<EmptyDescription>
								{emptyMessage ?? "No data for this range."}
							</EmptyDescription>
						</EmptyHeader>
					</Empty>
				) : (
					<>
						<ChartContainer
							config={chartConfig}
							className="aspect-auto w-full"
							style={{ height: chartHeight }}
						>
							<BarChart
								accessibilityLayer
								data={visibleData}
								layout="vertical"
								margin={{ left: 0, right: 40 }}
							>
								<CartesianGrid horizontal={false} />
								<YAxis
									dataKey="label"
									type="category"
									tickLine={false}
									tickMargin={8}
									axisLine={false}
									width={116}
									tickFormatter={(value: string) =>
										value.length > Y_AXIS_TICK_MAX_CHARS
											? `${value.slice(0, Y_AXIS_TICK_MAX_CHARS - 1)}…`
											: value
									}
								/>
								<XAxis dataKey="value" type="number" hide />
								<ChartTooltip
									cursor={false}
									content={<ChartTooltipContent indicator="line" />}
								/>
								<Bar
									dataKey="value"
									fill="var(--color-value)"
									radius={4}
									maxBarSize={28}
								>
									<LabelList
										dataKey="value"
										position="right"
										offset={8}
										className="fill-foreground"
										fontSize={12}
										formatter={(value) =>
											typeof value === "number"
												? formatWholeNumber(value)
												: value
										}
									/>
								</Bar>
							</BarChart>
						</ChartContainer>
						{hiddenCount > 0 ? (
							<p className="mt-2 text-xs text-muted-foreground">
								+{formatWholeNumber(hiddenCount)} more not shown
							</p>
						) : null}
					</>
				)}
			</CardContent>
		</Card>
	);
}
