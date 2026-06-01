"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Shared presentational primitives for the lead/customer detail surface.
 * The goal is a dense, luxurious, highly scannable layout: hairline chrome,
 * uppercase micro-labels, tabular figures, and consistent section framing.
 */

const SURFACE =
	"overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10 shadow-[0_1px_2px_0_oklch(0_0_0/0.04)]";

export function Surface({
	children,
	className,
	...props
}: React.ComponentProps<"section"> & { className?: string }) {
	return (
		<section className={cn(SURFACE, className)} {...props}>
			{children}
		</section>
	);
}

export function SectionShell({
	title,
	icon,
	count,
	meta,
	children,
	bodyClassName,
}: {
	title: string;
	icon?: ReactNode;
	count?: number;
	meta?: ReactNode;
	children: ReactNode;
	bodyClassName?: string;
}) {
	return (
		<Surface>
			<header className="flex items-center justify-between gap-3 border-b border-border/60 bg-muted/20 px-4 py-2.5">
				<div className="flex min-w-0 items-center gap-2">
					{icon ? (
						<span className="text-muted-foreground [&>svg]:size-4" aria-hidden="true">
							{icon}
						</span>
					) : null}
					<h2 className="truncate text-sm font-semibold tracking-tight">{title}</h2>
					{typeof count === "number" ? (
						<span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1.5 text-[11px] font-medium text-muted-foreground tabular-nums">
							{count}
						</span>
					) : null}
				</div>
				{meta ? (
					<div className="shrink-0 text-[11px] text-muted-foreground">{meta}</div>
				) : null}
			</header>
			<div className={bodyClassName}>{children}</div>
		</Surface>
	);
}

export function MicroLabel({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<span
			className={cn(
				"text-[10px] font-medium uppercase tracking-[0.09em] text-muted-foreground",
				className,
			)}
		>
			{children}
		</span>
	);
}

export function StatTile({
	label,
	value,
	hint,
	tone = "default",
	className,
}: {
	label: ReactNode;
	value: ReactNode;
	hint?: ReactNode;
	tone?: "default" | "money";
	className?: string;
}) {
	return (
		<div className={cn("flex min-w-0 flex-col gap-1 bg-card px-3.5 py-2.5", className)}>
			<MicroLabel>{label}</MicroLabel>
			<div
				className={cn(
					"truncate font-semibold tabular-nums",
					tone === "money"
						? "text-base text-emerald-600 dark:text-emerald-400"
						: "text-sm",
				)}
			>
				{value}
			</div>
			{hint ? (
				<div className="truncate text-[11px] text-muted-foreground">{hint}</div>
			) : null}
		</div>
	);
}

export function MetaRow({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground",
				className,
			)}
		>
			{children}
		</div>
	);
}

export function MetaDot() {
	return (
		<span aria-hidden="true" className="text-border/80 select-none">
			&middot;
		</span>
	);
}
