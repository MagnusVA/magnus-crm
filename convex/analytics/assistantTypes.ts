import type { RegisteredQuery } from "convex/server";
/** Argument type of an existing page reader, without using runtime internals. */
export type ReaderArgs<Reader> = Reader extends RegisteredQuery<"public", infer Args, infer _Returns> ? Args : never;
