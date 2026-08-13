import { v } from "convex/values";

export const LEAD_TYPES = ["pt", "content"] as const;

export type LeadType = (typeof LEAD_TYPES)[number];

export const LEAD_TYPE_LABELS: Record<LeadType, string> = {
  pt: "PT (Personal trainer)",
  content: "Content",
};

export const leadTypeValidator = v.union(
  v.literal("pt"),
  v.literal("content"),
);

const LEAD_TYPE_SET = new Set<string>(LEAD_TYPES);

export function isLeadType(value: unknown): value is LeadType {
  return typeof value === "string" && LEAD_TYPE_SET.has(value);
}
