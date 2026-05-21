import { v } from "convex/values";

export const portalPasswordHashParamsValidator = v.object({
  algorithm: v.literal("scrypt"),
  keyLength: v.number(),
  N: v.number(),
  r: v.number(),
  p: v.number(),
});
