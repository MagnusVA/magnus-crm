"use client";

import { useFormStatus } from "react-dom";
import { LogOutIcon } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { PORTAL_BRAND, PortalColumn } from "./portal-ui";

/** The navy head of every unlocked screen: brand line, then the screen's own content. */
export function PortalHeader({
	tenantName,
	action,
	sticky = false,
	children,
}: {
	tenantName: string;
	action?: React.ReactNode;
	sticky?: boolean;
	children: React.ReactNode;
}) {
	return (
		<header
			className={cn(
				"flex-none bg-board text-board-foreground",
				sticky && "sticky top-0 z-20",
			)}
		>
			<PortalColumn className="px-3.5 pt-[max(12px,env(safe-area-inset-top))] pb-2.5">
				<div className="flex min-h-6 items-center justify-between gap-3">
					<div className={cn(PORTAL_BRAND, "truncate")}>
						{tenantName}
						<span aria-hidden> · </span>
						Booking links
					</div>
					{action}
				</div>
				{children}
			</PortalColumn>
		</header>
	);
}

function SignOutSubmit() {
	const { pending } = useFormStatus();
	return (
		<button
			type="submit"
			disabled={pending}
			aria-label="Sign out of the booking links portal"
			title="Sign out"
			className="-mr-1.5 inline-flex h-7 items-center gap-1.5 rounded-[6px] px-1.5 text-[12px] text-board-muted outline-none hover:bg-board-raised hover:text-board-foreground focus-visible:ring-2 focus-visible:ring-primary/50"
		>
			{pending ? <Spinner className="size-3.5" /> : <LogOutIcon aria-hidden className="size-3.5" />}
			Sign out
		</button>
	);
}

/** Signs out through the existing server action (clears the httpOnly cookie). */
export function SignOutButton({ action }: { action: (formData: FormData) => Promise<void> }) {
	return (
		<form action={action}>
			<SignOutSubmit />
		</form>
	);
}
