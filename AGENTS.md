Always use pnpm for installing packages and running scripts from package.json.

Plans are to be setup and or read or referenced in plans/\*/\*\*

Thats where we will have
plans/featureset/design.md
as well as
plans/featureset/phases/phase1.md
plans/featureset/phases/phase2.md
so on and so forth.

For **Calendly** (OAuth, API v2, webhooks, scopes, rate limits), start from `.docs/calendly/index.md`. It indexes the local mirror under `.docs/calendly/` so agents can open the right file without guessing paths.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

<!-- END:nextjs-agent-rules -->

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read `convex/_generated/ai/guidelines.md` first** for important guidelines on how to correctly use Convex APIs and patterns. The file contains rules that override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running `npx convex ai-files install`.

<!-- convex-ai-end -->

## Available Skills Index

Invoke skills using the Skill tool when their trigger conditions are met. This ensures the model has specialized context and guidance for the task.

| Skill                | When to Invoke                                           | Key Trigger Words                                                    |
| -------------------- | -------------------------------------------------------- | -------------------------------------------------------------------- |
| **update-config**    | Configure Claude Code harness behavior via settings.json | "configure Claude Code", "set up hooks", "automated behavior"        |
| **keybindings-help** | Customize keyboard shortcuts or rebind keys              | "rebind", "keybinding", "keyboard shortcut", "change the submit key" |

### Code Quality & Performance

| Skill                        | When to Invoke                                         | Key Trigger Words                                                                 |
| ---------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------- |
| **convex-performance-audit** | Audit and optimize Convex performance                  | "slow", "expensive", "performance audit", "high bytes", "npx convex insights"     |
| **web-design-guidelines**    | Review UI code for Web Interface Guidelines compliance | "review UI", "check accessibility", "audit design", "review UX", "best practices" |

### Frontend Development

| Skill                             | When to Invoke                                              | Key Trigger Words                                                                    |
| --------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **frontend-design**               | Create production-grade frontend interfaces and components  | "build a component", "create a page", "design interface", "make it look good"        |
| **shadcn**                        | Manage shadcn/ui components, styling, and composition       | "add shadcn component", "fix component", "style component", "shadcn/ui"              |
| **vercel-react-best-practices**   | Apply React/Next.js performance optimization patterns       | "optimize React", "improve performance", "refactor component", "Next.js performance" |
| **vercel-react-view-transitions** | Implement smooth animations using React View Transition API | "add page transitions", "smooth animations", "view transitions", "page animation"    |
| **vercel-composition-patterns**   | Design scalable React composition patterns                  | "refactor component", "too many props", "compound components", "render props"        |
| **workos-widgets**                | Build and integrate WorkOS Widgets                          | "add WorkOS Widget", "User Management", "User Profile", "Admin Portal"               |

### Backend Development (Convex)

| Skill                       | When to Invoke                                          | Key Trigger Words                                                               |
| --------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **convex-quickstart**       | Initialize Convex project or add Convex to existing app | "new Convex project", "add Convex", "convex init", "setup Convex"               |
| **convex-setup-auth**       | Setup Convex authentication with user management        | "add login", "setup auth", "Convex Auth", "Clerk", "Auth0", "WorkOS AuthKit"    |
| **convex-migration-helper** | Plan and execute Convex schema and data migrations      | "schema migration", "deployment fails", "widen-migrate-narrow", "backfill data" |
| **convex-create-component** | Design and build isolated Convex components             | "create Convex component", "extract backend logic", "component with boundaries" |

### Third-party Integrations

| Skill      | When to Invoke                                          | Key Trigger Words                                                                 |
| ---------- | ------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **workos** | Implement or debug WorkOS (auth, SSO, SAML, SCIM, RBAC) | "WorkOS", "SSO", "SAML", "Directory Sync", "organization", "roles", "permissions" |

### Discovery & Help

| Skill           | When to Invoke                                         | Key Trigger Words                                                              |
| --------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| **find-skills** | Discover and install agent skills for new capabilities | "how do I do X", "is there a skill for", "find a skill", "extend capabilities" |
