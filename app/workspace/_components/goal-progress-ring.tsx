"use client";

import { useId, useMemo } from "react";
import { PencilIcon, TargetIcon } from "lucide-react";
import {
	Label,
	PolarAngleAxis,
	PolarRadiusAxis,
	RadialBar,
	RadialBarChart,
} from "recharts";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardAction,
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
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatWholeNumber } from "./overview-formatters";

const BREAKDOWN_COLORS = [
	"var(--chart-1)",
	"var(--chart-2)",
	"var(--chart-3)",
	"var(--chart-4)",
	"var(--chart-5)",
] as const;

export type GoalProgressBreakdownItem = {
	label: string;
	goal: number;
	progress: number;
};

export type GoalProgressRingProps = {
	/** Target for the range. `0` or `undefined` renders the "No goal set" state. */
	goal?: number;
	/** Achieved count for the range. */
	progress: number;
	/** Card title, e.g. "Team goal". */
	label: string;
	/** Optional card description, e.g. the range label or goal math. */
	sublabel?: string;
	/** Optional per-item (e.g. per-team) goals rendered as a legend under the ring. */
	breakdown?: GoalProgressBreakdownItem[];
	/** When provided, renders a small "Edit goal" affordance. */
	onEdit?: () => void;
	className?: string;
};

function goalPercent(progress: number, goal: number) {
	if (goal <= 0) {
		return null;
	}
	return Math.round((progress / goal) * 100);
}

function EditGoalButton({ onEdit }: { onEdit: () => void }) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					onClick={onEdit}
					aria-label="Edit goal"
				>
					<PencilIcon aria-hidden="true" />
				</Button>
			</TooltipTrigger>
			<TooltipContent>Edit goal</TooltipContent>
		</Tooltip>
	);
}

function NoGoalState({
	progress,
	onEdit,
}: {
	progress: number;
	onEdit?: () => void;
}) {
	return (
		<div className="flex min-h-[200px] flex-col items-center justify-center gap-2 text-center">
			<div className="flex size-10 items-center justify-center rounded-full bg-muted">
				<TargetIcon
					className="size-5 text-muted-foreground"
					aria-hidden="true"
				/>
			</div>
			<p className="text-sm font-medium">No goal set</p>
			<p className="text-xs text-muted-foreground">
				{formatWholeNumber(progress)} recorded in this range. Set a goal to
				track progress against it.
			</p>
			{onEdit ? (
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="mt-1"
					onClick={onEdit}
				>
					<PencilIcon data-icon="inline-start" aria-hidden="true" />
					Set goal
				</Button>
			) : null}
		</div>
	);
}

function BreakdownLegend({
	breakdown,
}: {
	breakdown: GoalProgressBreakdownItem[];
}) {
	return (
		<ul
			className="flex flex-col gap-1 border-t pt-3"
			aria-label="Goal breakdown"
		>
			{breakdown.map((item, index) => {
				const percent = goalPercent(item.progress, item.goal);
				const barWidth =
					percent === null ? 0 : Math.max(0, Math.min(100, percent));
				return (
					<li key={`${item.label}-${index}`}>
						<Tooltip>
							<TooltipTrigger asChild>
								<div className="flex cursor-default items-center gap-2 rounded px-1.5 py-1 text-xs transition-colors hover:bg-muted/50">
									<span
										className="size-2 shrink-0 rounded-[2px]"
										style={{
											backgroundColor:
												BREAKDOWN_COLORS[index % BREAKDOWN_COLORS.length],
										}}
										aria-hidden="true"
									/>
									<span className="min-w-0 flex-1 truncate">{item.label}</span>
									<span
										className="hidden h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted sm:block"
										aria-hidden="true"
									>
										<span
											className="block h-full rounded-full"
											style={{
												width: `${barWidth}%`,
												backgroundColor:
													BREAKDOWN_COLORS[index % BREAKDOWN_COLORS.length],
											}}
										/>
									</span>
									<span className="shrink-0 font-medium tabular-nums">
										{formatWholeNumber(item.progress)}
										<span className="font-normal text-muted-foreground">
											{" "}
											/ {formatWholeNumber(item.goal)}
										</span>
									</span>
								</div>
							</TooltipTrigger>
							<TooltipContent side="top" className="max-w-xs text-pretty">
								{item.label}: {formatWholeNumber(item.progress)} of{" "}
								{formatWholeNumber(item.goal)} goal
								{percent === null ? " (no goal set)" : ` (${percent}%)`}
							</TooltipContent>
						</Tooltip>
					</li>
				);
			})}
		</ul>
	);
}

/**
 * Radial goal progress card in the shadcn "Radial Chart - Text" style:
 * a rounded gauge arc over a muted background track with the progress
 * count centered inside the ring.
 */
export function GoalProgressRing({
	goal,
	progress,
	label,
	sublabel,
	breakdown,
	onEdit,
	className,
}: GoalProgressRingProps) {
	const chartId = useId().replace(/:/g, "");
	const hasGoal = typeof goal === "number" && goal > 0;
	const percent = hasGoal ? goalPercent(progress, goal) : null;

	const chartData = useMemo(
		() => [
			{
				name: "progress",
				value: hasGoal ? Math.min(progress, goal) : 0,
				fill: "var(--color-progress)",
			},
		],
		[hasGoal, progress, goal],
	);

	const chartConfig = useMemo<ChartConfig>(
		() => ({
			progress: {
				label: "Progress",
				color: "var(--chart-1)",
			},
		}),
		[],
	);

	return (
		<Card className={className}>
			<CardHeader>
				<CardTitle>{label}</CardTitle>
				{sublabel ? <CardDescription>{sublabel}</CardDescription> : null}
				{onEdit && hasGoal ? (
					<CardAction>
						<EditGoalButton onEdit={onEdit} />
					</CardAction>
				) : null}
			</CardHeader>
			<CardContent className="flex flex-col gap-3">
				{!hasGoal ? (
					<NoGoalState progress={progress} onEdit={onEdit} />
				) : (
					<>
						<ChartContainer
							id={chartId}
							config={chartConfig}
							className="mx-auto aspect-square w-full max-w-[250px]"
						>
							<RadialBarChart
								data={chartData}
								startAngle={215}
								endAngle={-35}
								innerRadius={80}
								outerRadius={104}
							>
								<ChartTooltip
									cursor={false}
									content={<ChartTooltipContent hideLabel nameKey="name" />}
								/>
								<PolarAngleAxis
									type="number"
									domain={[0, goal]}
									angleAxisId={0}
									tick={false}
								/>
								<RadialBar
									dataKey="value"
									angleAxisId={0}
									background
									cornerRadius={12}
								/>
								<PolarRadiusAxis tick={false} tickLine={false} axisLine={false}>
									<Label
										content={({ viewBox }) => {
											if (
												!viewBox ||
												!("cx" in viewBox) ||
												!("cy" in viewBox)
											) {
												return null;
											}
											const cx = viewBox.cx ?? 0;
											const cy = viewBox.cy ?? 0;
											return (
												<text
													x={cx}
													y={cy}
													textAnchor="middle"
													dominantBaseline="middle"
												>
													<tspan
														x={cx}
														y={cy - 6}
														className="fill-foreground text-3xl font-bold tabular-nums"
													>
														{formatWholeNumber(progress)}
													</tspan>
													<tspan
														x={cx}
														y={cy + 18}
														className="fill-muted-foreground text-xs"
													>
														of {formatWholeNumber(goal)} goal
													</tspan>
												</text>
											);
										}}
									/>
								</PolarRadiusAxis>
							</RadialBarChart>
						</ChartContainer>
						<p className="text-center text-sm text-muted-foreground">
							<span
								className={cn(
									"font-semibold tabular-nums",
									percent !== null && percent >= 100
										? "text-foreground"
										: "text-foreground/90",
								)}
							>
								{percent}%
							</span>{" "}
							of goal
							{percent !== null && percent >= 100 ? " — goal reached" : ""}
						</p>
						{breakdown && breakdown.length > 0 ? (
							<BreakdownLegend breakdown={breakdown} />
						) : null}
					</>
				)}
			</CardContent>
		</Card>
	);
}
