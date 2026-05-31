"use client";

import { createContext, use, type ReactNode } from "react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";

type EntityDetailResult = FunctionReturnType<
	typeof api.leadCustomers.detail.getEntityDetail
>;
export type EntityDetailPayload = Extract<EntityDetailResult, { kind: "detail" }>;
export type EntityDetailOpportunity = EntityDetailPayload["opportunities"][number];
export type EntityDetailMeeting = EntityDetailPayload["meetings"][number];
export type EntityDetailComment = EntityDetailPayload["comments"][number];

const EntityDetailContext = createContext<EntityDetailPayload | null>(null);

export function EntityDetailProvider({
	detail,
	children,
}: {
	detail: EntityDetailPayload;
	children: ReactNode;
}) {
	return <EntityDetailContext value={detail}>{children}</EntityDetailContext>;
}

export function useEntityDetail() {
	const detail = use(EntityDetailContext);
	if (!detail) {
		throw new Error("useEntityDetail must be used inside EntityDetailProvider");
	}
	return detail;
}
