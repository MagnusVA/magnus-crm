import { cn } from "@/lib/utils";

/** "PT-DOMINATION · BOOKING LINKS": the small condensed line over every screen. */
export const PORTAL_BRAND =
	"font-condensed text-[11px] leading-none font-semibold tracking-[0.16em] text-board-muted uppercase";

/** Small condensed section label on the light part of the sheet. */
export const PORTAL_LABEL =
	"font-condensed text-[11px] leading-none font-semibold tracking-[0.14em] text-muted-foreground uppercase";

/**
 * The portal is phone-first: one narrow column, full width on a phone and
 * centred on a desktop.
 */
export function PortalColumn({
	className,
	children,
}: {
	className?: string;
	children: React.ReactNode;
}) {
	return <div className={cn("mx-auto w-full max-w-[440px]", className)}>{children}</div>;
}

export function CloserInitials({ name, className }: { name: string; className?: string }) {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	const letters =
		parts.length > 1
			? `${parts[0]?.[0] ?? ""}${parts.at(-1)?.[0] ?? ""}`
			: (parts[0]?.slice(0, 2) ?? "");
	return (
		<span
			aria-hidden="true"
			className={cn(
				"grid size-7 flex-none place-items-center rounded-full bg-muted font-condensed text-[12px] leading-none font-semibold tracking-[0.04em] text-foreground",
				className,
			)}
		>
			{letters.toUpperCase()}
		</span>
	);
}
