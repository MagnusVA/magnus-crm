import Link from "next/link";
import { SearchXIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";

export function EntityDetailNotFound() {
	return (
		<div className="mx-auto flex w-full max-w-2xl flex-col px-4 py-16">
			<Empty className="border">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<SearchXIcon aria-hidden="true" />
					</EmptyMedia>
					<EmptyTitle>Lead Not Found</EmptyTitle>
					<EmptyDescription>
						This record is unavailable or you do not have access to it.
					</EmptyDescription>
				</EmptyHeader>
				<Button asChild variant="outline" className="mx-auto">
					<Link href="/workspace/leads-customers">Back To Leads & Customers</Link>
				</Button>
			</Empty>
		</div>
	);
}
