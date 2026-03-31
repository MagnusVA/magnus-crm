"use client";

import { useMutation, useQuery } from "convex/react";
import { FormEvent, useState } from "react";
import { api } from "../convex/_generated/api";

export default function Home() {
  const todos = useQuery(api.todos.list);
  const create = useMutation(api.todos.create);
  const toggle = useMutation(api.todos.toggle);
  const remove = useMutation(api.todos.remove);
  const [draft, setDraft] = useState("");

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    await create({ text });
    setDraft("");
  }

  return (
    <div className="flex flex-1 flex-col items-center bg-zinc-50 px-4 py-16 dark:bg-black">
      <main className="w-full max-w-md space-y-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Todos
          </h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Stored in Convex — run <code className="rounded bg-zinc-200 px-1 py-0.5 text-xs dark:bg-zinc-800">pnpm convex:dev</code>{" "}
            alongside <code className="rounded bg-zinc-200 px-1 py-0.5 text-xs dark:bg-zinc-800">pnpm dev</code>.
          </p>
        </div>

        <form onSubmit={onSubmit} className="flex gap-2">
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="What needs doing?"
            className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 outline-none ring-zinc-400 focus:ring-2 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50 dark:ring-zinc-500"
            aria-label="New todo"
          />
          <button
            type="submit"
            className="shrink-0 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            Add
          </button>
        </form>

        {todos === undefined ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
        ) : todos.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No todos yet.</p>
        ) : (
          <ul className="space-y-2">
            {todos.map((todo) => (
              <li
                key={todo._id}
                className="flex items-center gap-3 rounded-lg border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950"
              >
                <input
                  type="checkbox"
                  checked={todo.completed}
                  onChange={() => toggle({ todoId: todo._id })}
                  className="size-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-500 dark:border-zinc-600"
                  aria-label={`Mark "${todo.text}" as ${todo.completed ? "incomplete" : "complete"}`}
                />
                <span
                  className={
                    todo.completed
                      ? "flex-1 text-sm text-zinc-400 line-through dark:text-zinc-500"
                      : "flex-1 text-sm text-zinc-900 dark:text-zinc-100"
                  }
                >
                  {todo.text}
                </span>
                <button
                  type="button"
                  onClick={() => remove({ todoId: todo._id })}
                  className="text-xs font-medium text-zinc-500 hover:text-red-600 dark:text-zinc-400 dark:hover:text-red-400"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
