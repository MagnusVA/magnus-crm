# Update AGENTS.md — Prompt & Methodology

**Purpose:** This document defines the prompt, exploration strategy, and quality standards for regenerating `AGENTS.md` when the codebase has evolved. The goal is to audit the **actual code** and produce an accurate, comprehensive guide that AI agents can rely on when building new features.

---

## When to Use

Re-run this process when:

- New architectural patterns have been established (new auth flow, new page pattern, etc.)
- Major features have shipped that change how things are built
- New skills, tools, or integrations have been added to the project
- Existing documentation in AGENTS.md has drifted from reality
- A stabilization point has been reached after heavy development

---

## Prompt

Copy and paste the following prompt into a new conversation:

```
I need you to audit the current codebase and regenerate AGENTS.md with accurate, comprehensive standards documentation.

## What to do

1. **Explore the codebase in parallel** across these 5 areas (use subagents):

   a. **Auth & RBAC** — How authentication works end-to-end (providers, session management, JWT flow). How RBAC is implemented (roles, permissions, guards). Check: lib/auth.ts, convex/requireTenantUser.ts, convex/requireSystemAdmin.ts, convex/lib/permissions.ts, convex/lib/roleMapping.ts, convex/lib/identity.ts, app/ConvexClientProvider.tsx, app/callback/, middleware if any.

   b. **RSC, Streaming & Rendering** — PPR status (check next.config.ts for experimental.ppr), Suspense boundary usage, skeleton/loading patterns, server vs client component organization, "use client" boundaries, preloading patterns (preloadQuery/usePreloadedQuery), loading.tsx files, error boundaries. Check: app/workspace/layout.tsx, app/workspace/_components/, all loading.tsx files, all page.tsx files for exports like unstable_instant.

   c. **Convex Backend** — Schema design patterns (convex/schema.ts), function organization (queries/mutations/actions), auth guards, validators, internal vs public functions, pagination, indexing, denormalization, webhook processing, cron jobs, logging conventions. Check: convex/ directory thoroughly, convex/_generated/ai/guidelines.md.

   d. **Frontend Architecture** — Route structure, component organization, shadcn/ui usage, styling approach (Tailwind config, globals.css), state management (Convex queries, context, hooks), form handling patterns, provider nesting, custom hooks, dynamic imports. Check: app/ directory tree, components/, hooks/, package.json, next.config.ts, components.json, tailwind config.

   e. **Project Config & Tooling** — Package manager, TypeScript config, ESLint, manual QA workflow (TESTING.MD), CI/CD, environment variables, deployment config, .agents/skills/ directory, plans/ structure, .docs/ structure. Check: root config files, .agents/, TESTING.MD.

2. **Read key files directly** to verify patterns found by exploration:
   - convex/_generated/ai/guidelines.md
   - app/workspace/layout.tsx
   - lib/auth.ts
   - convex/requireTenantUser.ts
   - app/ConvexClientProvider.tsx
   - next.config.ts

3. **Write the enhanced AGENTS.md** following these rules:

## Structural rules

- Start with the migration warning (production tenant exists)
- Include a Table of Contents
- Organize into: Plans & Docs, Codebase Standards, Framework Guidance, Skills, Quick Reference
- Document patterns with **actual code from this codebase** — not generic examples
- Reference **actual file paths** so agents can navigate directly
- Include tables for quick scanning (role permissions, auth helpers, hooks, key files)

## Content that MUST be preserved verbatim

These two HTML comment blocks must appear exactly as-is (content between the markers untouched). They may be repositioned within the document but their inner content must not change:

1. <!-- BEGIN:nextjs-agent-rules --> ... <!-- END:nextjs-agent-rules -->
2. <!-- convex-ai-start --> ... <!-- convex-ai-end -->

Read the current AGENTS.md first to extract these blocks before overwriting.

## Content sections to include

For each section, document WHAT the pattern is, WHERE it lives (file paths), and HOW to follow it:

- **Multi-Tenant Model** — org-to-tenant mapping, data isolation, tenant lifecycle states
- **Authentication** — full auth chain (frontend providers, server-side helpers, Convex guards, callback flows)
- **Authorization (RBAC)** — roles, permission table, authorization at each layer (RSC, layout, Convex, client UI), key rules
- **RSC & Streaming Architecture** — the page pattern (layers), provider nesting order, why each layer exists
- **Suspense & Error Isolation** — skeleton strategy, SectionErrorBoundary, loading.tsx convention
- **Preloading Pattern** — preloadQuery in RSC → usePreloadedQuery in client
- **Client-Side Role Context** — RoleProvider, useRole(), UI-only enforcement
- **Convex Backend Standards** — file organization tree, schema patterns, function patterns, webhook pipeline, logging standard, cron patterns
- **Frontend Architecture** — route structure, component organization, naming conventions, custom hooks table, dynamic imports
- **State Management** — what tools are used at each layer (no external state library)
- **Form Patterns** — manual useState approach, validation, toast feedback, compound form components
- **Styling & Theming** — Tailwind 4, OKLCH, shadcn config, CSS import order, dark mode
- **Analytics** — PostHog client/server, proxy rewrites, Web Vitals, user identification
- **Testing** — point to `TESTING.MD` for the manual QA workflow (Convex CLI seeding + CLI validation + human browser verification). Do not add any automated browser-QA or MCP-based testing guidance.
- **Next.js patterns table** — key patterns specific to this codebase's Next.js usage
- **Skills table** — all available skills with trigger words and when to invoke
- **Quick Reference: Key Files** — table mapping important files to their purpose

## Quality checks before finishing

- [ ] Both HTML comment blocks are preserved verbatim
- [ ] All file paths referenced actually exist in the codebase
- [ ] No patterns described that don't match the actual code
- [ ] PPR status accurately reflects what's in next.config.ts (don't claim it's enabled if the flag isn't set)
- [ ] Testing is described as manual QA (see TESTING.MD) — no automated browser-QA tooling is in use
- [ ] Skills table includes ALL skills from .agents/skills/
- [ ] No generic/placeholder code examples — use actual patterns from this codebase
```

---

## Exploration Strategy

The prompt above instructs the agent to run **5 parallel exploration subagents** covering orthogonal areas. This is critical for speed — a sequential audit of this codebase would take significantly longer. The areas are designed to have minimal overlap:

| Agent    | Primary directories                                      | Key files to read                                        |
| -------- | -------------------------------------------------------- | -------------------------------------------------------- |
| Auth     | `lib/`, `convex/lib/`, `convex/workos/`, `app/callback/` | `lib/auth.ts`, `convex/requireTenantUser.ts`             |
| RSC      | `app/workspace/`, all `loading.tsx`                      | `app/workspace/layout.tsx`, skeleton files               |
| Convex   | `convex/` (all subdirs)                                  | `convex/schema.ts`, `convex/_generated/ai/guidelines.md` |
| Frontend | `app/`, `components/`, `hooks/`                          | `package.json`, `next.config.ts`, `components.json`      |
| Config   | root config files, `.agents/`, `.docs/`                  | `TESTING.MD`, `tsconfig.json`, `pnpm-lock.yaml`          |

After the parallel exploration, the agent reads ~6 key files directly to verify findings before writing.

---

## What NOT to change

- The `<!-- BEGIN:nextjs-agent-rules -->` block is consumed by external tooling. Its inner content must remain exactly as committed — only its **position** in the document may move.
- The `<!-- convex-ai-start -->` block is similarly consumed. Same rule.
- Do not add aspirational patterns — only document what **actually exists in the code right now**.
- Do not remove the skills table. If new skills have been added to `.agents/skills/`, add them. If skills have been removed, drop them.

---

## Post-Update Verification

After the AGENTS.md rewrite, verify:

1. `grep -c "BEGIN:nextjs-agent-rules" AGENTS.md` returns `1`
2. `grep -c "convex-ai-start" AGENTS.md` returns `1`
3. All file paths mentioned in the doc exist (`grep -oP '`[^`]+\.(ts|tsx|js|json|css|md)`' AGENTS.md | sort -u | while read f; do [ ! -f "$f" ] && echo "MISSING: $f"; done`)
4. The skills table matches the contents of `.agents/skills/`
