# Magnus CRM

Magnus CRM is a multi-tenant sales CRM for teams that book sales calls through Calendly. Closers work their meetings, payments, and follow-ups; admins run operations dashboards, lead gen, billing, and a Slack bot that logs qualified leads.

Production holds one live test tenant, so any schema or data change needs a migration plan: use the `convex-migration-helper` skill and the migrations section of `docs/agents/convex.md`.

## Commands

The package manager is pnpm. Install with `pnpm install`, and run scripts with `pnpm <script>`:

| Command | What it does |
| --- | --- |
| `pnpm dev` | Starts the Next.js dev server on `localhost:3000` |
| `pnpm convex:dev` | Syncs `convex/` to the dev deployment, pushes the schema, and regenerates `convex/_generated` |
| `pnpm build` / `pnpm start` | Builds and serves production Next.js |
| `pnpm typecheck` | Generates Next.js route types, then runs TypeScript 7 (`tsgo`) with `--noEmit` on the app and on `convex/tsconfig.json` |
| `pnpm lint` | Runs ESLint with the Next.js core web vitals and TypeScript configs |
| `pnpm test` | Runs Vitest over `convex/**/*.test.ts` and `lib/operations-reports/**/*.test.ts` |
| `pnpm expose` | Opens an ngrok tunnel from a fixed public URL to `localhost:3000` |

CI (`.github/workflows/ci.yml`) runs `pnpm lint`, `pnpm typecheck`, and `pnpm test` as parallel jobs on every pull request and every push to `main`. Lint warnings don't fail the build; errors do.

TypeScript 7 has no JavaScript compiler API yet, so `.pnpmfile.cjs` pins the typescript-eslint packages to TypeScript 6.0.3, the newest version they accept. Keep that pin when upgrading dependencies, or `pnpm lint` breaks. Next.js and the Convex CLI both type-check with the TypeScript 7 `tsc`.

The Convex CLI inspects backend state:

- `npx convex data <table>` lists rows, and `npx convex logs` streams function logs
- `npx convex run <module>:<function> '<json args>'` calls any function, internal ones included
- `npx convex run testing/calendly:bookTestInvitee` books a real Calendly test meeting

## Stack

Next.js 16 App Router, React 19, Convex, WorkOS AuthKit, shadcn/ui with Tailwind CSS 4, and PostHog. State lives in Convex hooks, React context, and component state; the app has no client state library.

## Rules for every task

- Every tenant table carries `tenantId`, and functions take tenant, user, and role from the auth identity rather than from arguments.
- Every public Convex function checks auth. Backfills, migrations, and server-only logic are `internal*` functions.
- Pages and Convex functions each enforce access; `useRole()` in the UI only hides controls.
- Writes to meetings, opportunities, payments, leads, or customers have side effects that code maintains by hand. Read "Write side effects" in `docs/agents/convex.md` before adding one.

## Topic guides

- Convex code: `docs/agents/convex.md`
- Pages, components, forms, styling, and analytics: `docs/agents/frontend.md`
- Roles, permissions, guards, system admin, and the DM portal: `docs/agents/auth.md`
- Vendor API docs (Calendly, Slack, Convex, PostHog, WorkOS) live in `.docs/<vendor>/`; Calendly starts at `.docs/calendly/index.md`

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
