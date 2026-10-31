import { cn } from "@/lib/utils";

/**
 * A ruled section of the deal modal: a 44px title row with optional meta
 * pushed right (DetailCard's title row, without a card of its own inside
 * the modal), then its rows. A rule separates it from the section above.
 */
export function DealModalSection({
	title,
	meta,
	className,
	children,
}: {
	title: string;
	meta?: React.ReactNode;
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<section className={cn("border-t", className)}>
			<div className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 border-b px-4 py-2 sm:px-5">
				<h3 className="text-[0.9375rem] font-semibold">{title}</h3>
				{meta ? (
					<div className="ml-auto flex min-w-0 items-center gap-2 text-[0.8125rem] text-muted-foreground">
						{meta}
					</div>
				) : null}
			</div>
			{children}
		</section>
	);
}

/** A plain text block (notes, the lost reason): a title, a fact beside it, the text under it. */
export function DealModalTextBlock({
	title,
	meta,
	className,
	children,
}: {
	title: string;
	meta?: React.ReactNode;
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<section className="border-t px-4 py-3 sm:px-5">
			<div className="flex flex-wrap items-baseline gap-x-2">
				<h3 className="text-[0.9375rem] font-semibold">{title}</h3>
				{meta ? <span className="text-[0.8125rem] text-muted-foreground">{meta}</span> : null}
			</div>
			<p
				className={cn("mt-1 max-w-[70ch] text-sm leading-relaxed wrap-break-word whitespace-pre-wrap", className)}
				translate="no"
			>
				{children}
			</p>
		</section>
	);
}
