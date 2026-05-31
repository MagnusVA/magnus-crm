"use client";

import { Badge } from "@/components/ui/badge";
import { useEntityDetail } from "./entity-detail-context";
import { formatToken } from "./entity-detail-formatters";

export function EntityFieldsIdentifiersSection() {
	const { lead, identifiers } = useEntityDetail();
	const customFields = Object.entries(lead.customFields ?? {});

	return (
		<section className="rounded-md border">
			<div className="border-b p-3">
				<h2 className="text-sm font-semibold">Fields & Identifiers</h2>
			</div>
			<div className="grid gap-4 p-3 lg:grid-cols-2">
				<div className="min-w-0">
					<h3 className="text-xs font-medium uppercase text-muted-foreground">
						Identifiers
					</h3>
					<div className="mt-2 flex flex-wrap gap-2">
						{identifiers.length === 0 ? (
							<span className="text-sm text-muted-foreground">
								No identifiers recorded.
							</span>
						) : (
							identifiers.map((identifier) => (
								<Badge key={identifier._id} variant="outline" title={identifier.rawValue}>
									<span className="max-w-[18rem] truncate">
										{formatToken(identifier.type)}: {identifier.rawValue}
									</span>
								</Badge>
							))
						)}
					</div>
				</div>
				<div className="min-w-0">
					<h3 className="text-xs font-medium uppercase text-muted-foreground">
						Custom Fields
					</h3>
					{customFields.length === 0 ? (
						<div className="mt-2 text-sm text-muted-foreground">
							No custom fields recorded.
						</div>
					) : (
						<dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
							{customFields.map(([key, value]) => (
								<div key={key} className="min-w-0 rounded-md bg-muted/35 p-2">
									<dt className="truncate text-muted-foreground">{key}</dt>
									<dd className="break-words font-medium">{value}</dd>
								</div>
							))}
						</dl>
					)}
				</div>
			</div>
		</section>
	);
}
