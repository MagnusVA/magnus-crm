import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("todos").order("desc").collect();
  },
});

export const create = mutation({
  args: { text: v.string() },
  handler: async (ctx, args) => {
    const text = args.text.trim();
    if (text.length === 0) {
      throw new Error("Todo text cannot be empty");
    }
    return await ctx.db.insert("todos", {
      text,
      completed: false,
    });
  },
});

export const toggle = mutation({
  args: { todoId: v.id("todos") },
  handler: async (ctx, args) => {
    const todo = await ctx.db.get(args.todoId);
    if (!todo) {
      throw new Error("Todo not found");
    }
    await ctx.db.patch(args.todoId, { completed: !todo.completed });
  },
});

export const remove = mutation({
  args: { todoId: v.id("todos") },
  handler: async (ctx, args) => {
    const todo = await ctx.db.get(args.todoId);
    if (!todo) {
      throw new Error("Todo not found");
    }
    await ctx.db.delete(args.todoId);
  },
});
