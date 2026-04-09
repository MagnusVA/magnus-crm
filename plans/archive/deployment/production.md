# Production Deployment Guide — Magnus CRM

## Overview

This guide covers deploying Magnus CRM from local development to a fully operational production environment.

| Layer          | Service          | Notes                                      |
| -------------- | ---------------- | ------------------------------------------ |
| Frontend       | **Vercel**       | Next.js 16.2.1, React 19, auto-deploy      |
| Backend        | **Convex**       | Serverless DB + functions, real-time subs   |
| Auth           | **WorkOS**       | AuthKit (SSO, User Management, Orgs)        |
| OAuth / CRM    | **Calendly**     | OAuth v2, webhooks, event sync              |
| Source control  | **GitHub**       | Not yet created — setup instructions below |
| Package manager | **pnpm**        | Required — do not use npm/yarn              |

**Git strategy**: two long-lived branches — `main` (production) and `dev` (staging/integration).

> **📌 Status Notes (updated 2026-04-04)**
>
> - **No custom domain yet** — a domain has not been purchased. Until then, all `https://yourdomain.com` references in this guide are placeholders. The Vercel-assigned `*.vercel.app` URL can be used as a temporary stand-in once the project is deployed.
> - **`WORKOS_WEBHOOK_SECRET`** and **`NEXT_PUBLIC_APP_URL`** cannot be set until the production environment is up and a domain (or Vercel URL) is known. See the [blocker note in Step 4](#7-step-4--environment-variables-complete-matrix).
> - **`SYSTEM_ADMIN_ORG_ID`** is now an environment variable (no longer hardcoded). It must be set as a Convex deployment env var for every environment. See `convex/lib/constants.ts`.

---

## Table of Contents

1. [Architecture](#1-architecture)
2. [Git Branching Strategy](#2-git-branching-strategy)
3. [Step 0 — Push to GitHub](#3-step-0--push-to-github)
4. [Step 1 — Update convex.json for All Environments](#4-step-1--update-convexjson-for-all-environments)
5. [Step 2 — Convex Production Setup](#5-step-2--convex-production-setup)
6. [Step 3 — Vercel Project Setup](#6-step-3--vercel-project-setup)
7. [Step 4 — Environment Variables (Complete Matrix)](#7-step-4--environment-variables-complete-matrix)
8. [Step 5 — WorkOS: What Convex Manages vs What You Manage](#8-step-5--workos-what-convex-manages-vs-what-you-manage)
9. [Step 6 — Calendly OAuth Production Configuration](#9-step-6--calendly-oauth-production-configuration)
10. [Step 7 — Custom Domain Setup](#10-step-7--custom-domain-setup)
11. [Step 8 — First Production Deployment](#11-step-8--first-production-deployment)
12. [Deployment Environments](#12-deployment-environments)
13. [CI/CD — How It All Connects](#13-cicd--how-it-all-connects)
14. [Rollback Procedures](#14-rollback-procedures)
15. [Convex Schema Safety & Migrations](#15-convex-schema-safety--migrations)
16. [Monitoring & Observability](#16-monitoring--observability)
17. [Security Best Practices](#17-security-best-practices)
18. [Scaling & Performance](#18-scaling--performance)
19. [Troubleshooting](#19-troubleshooting)
20. [Maintenance Schedule](#20-maintenance-schedule)
21. [Pre-Deployment Checklist](#21-pre-deployment-checklist)
22. [FAQ](#22-faq)
23. [Resources](#23-resources)

---

## 1. Architecture

```
                          ┌──────────────────────────────────┐
                          │         GitHub Repository         │
                          │  main (prod)  ←──  dev (staging)  │
                          └──────┬────────────────┬──────────┘
                                 │                │
                    push to main │                │ push to dev / PR
                                 │                │
                    ┌────────────▼──┐    ┌────────▼─────────┐
                    │   Vercel      │    │   Vercel          │
                    │  PRODUCTION   │    │  PREVIEW          │
                    │  yourdomain   │    │  *.vercel.app     │
                    └──────┬───────┘    └──────┬────────────┘
                           │                   │
          CONVEX_DEPLOY_KEY│    CONVEX_DEPLOY_ │ KEY (preview)
          (production)     │    (preview)      │
                    ┌──────▼───────┐    ┌──────▼────────────┐
                    │   Convex     │    │   Convex           │
                    │  PRODUCTION  │    │  PREVIEW / DEV     │
                    │  deployment  │    │  deployment        │
                    └──────────────┘    └────────────────────┘
                           │                   │
                    ┌──────▼───────────────────▼────────────┐
                    │         External Services              │
                    │  WorkOS (Auth)  •  Calendly (CRM)      │
                    │  Each with prod & dev credentials      │
                    └──────────────────────────────────────-─┘
```

### How the build pipeline works

When Vercel detects a push, it runs the **build command**:

```bash
npx convex deploy --cmd 'pnpm build'
```

This single command:
1. Reads `CONVEX_DEPLOY_KEY` from the Vercel environment
2. Pushes all Convex functions + schema to the correct Convex deployment
3. Sets `CONVEX_URL` in the environment for the frontend build
4. Runs `pnpm build` (Next.js production build) with that URL

This is the **critical integration point** — Convex and Vercel deploy together in one atomic step.

---

## 2. Git Branching Strategy

### Branch Structure

```
main (production)
 │  └─ Always deployable. Protected. Triggers production deploy.
 │
 └── dev (staging / integration)
      │  └─ Integration branch. Triggers preview deploy.
      │
      ├── feature/calendly-sync
      ├── fix/auth-redirect
      └── chore/upgrade-deps
```

### Branch Rules

#### `main` — Production

| Rule                                | Setting  |
| ----------------------------------- | -------- |
| Require PR before merging           | ✅ Yes   |
| Required approving reviews          | 1+       |
| Require status checks to pass       | ✅ Yes   |
| Require branch to be up to date     | ✅ Yes   |
| Dismiss stale reviews on new push   | ✅ Yes   |
| Allow force pushes                  | ❌ Never |
| Allow deletions                     | ❌ Never |

#### `dev` — Staging

| Rule                                | Setting  |
| ----------------------------------- | -------- |
| Require PR before merging           | ✅ Yes   |
| Required approving reviews          | 1 (lighter review) |
| Require status checks to pass       | ✅ Yes   |
| Allow force pushes                  | ❌ No    |

#### Feature Branches

- **Naming**: `feature/<name>`, `fix/<name>`, `chore/<name>`
- **Base**: Always branch from `dev`
- **Merge strategy**: Squash-merge into `dev`
- **Auto-delete**: Enable in GitHub repo settings

### Development Flow

```
1.  git checkout dev && git pull
2.  git checkout -b feature/my-thing
3.  ... make changes ...
4.  git push -u origin feature/my-thing
5.  Open PR → dev (Vercel creates preview deployment)
6.  Code review → merge to dev
7.  QA on staging
8.  Open PR → main (release PR)
9.  Approve + merge → production deploys automatically
10. Tag release: git tag v1.x.x && git push --tags
```

---

## 3. Step 0 — Push to GitHub

The repository is not yet on GitHub. Here's the setup:

### Create the repository

```bash
# 1. Create a new repo on GitHub (via CLI)
gh auth login                            # authenticate if not already
gh repo create ptdom-crm --private --source=. --remote=origin

# OR if you prefer to create via GitHub UI first:
# git remote add origin git@github.com:<your-org>/ptdom-crm.git
```

### Initial push with branch structure

```bash
# 2. Ensure you're on what will become 'main'
git branch -M main

# 3. Push main branch
git push -u origin main

# 4. Create and push dev branch
git checkout -b dev
git push -u origin dev

# 5. Go back to dev for day-to-day work
git checkout dev
```

### Configure branch protections

```bash
# Protect main branch
gh api repos/{owner}/{repo}/branches/main/protection \
  --method PUT \
  --field required_status_checks='{"strict":true,"contexts":[]}' \
  --field enforce_admins=true \
  --field required_pull_request_reviews='{"required_approving_review_count":1,"dismiss_stale_reviews":true}' \
  --field restrictions=null

# Protect dev branch (lighter)
gh api repos/{owner}/{repo}/branches/dev/protection \
  --method PUT \
  --field required_status_checks='{"strict":true,"contexts":[]}' \
  --field enforce_admins=false \
  --field required_pull_request_reviews='{"required_approving_review_count":1}' \
  --field restrictions=null
```

### Repository settings

```bash
# Enable auto-delete of merged branches
gh api repos/{owner}/{repo} --method PATCH --field delete_branch_on_merge=true

# Set default branch to dev (feature branches target dev by default)
gh api repos/{owner}/{repo} --method PATCH --field default_branch=dev
```

### Ensure `.gitignore` includes

```gitignore
# Environment files — NEVER commit
.env
.env.local
.env.production
.env.*.local

# Convex generated files
convex/_generated/

# Dependencies
node_modules/

# Next.js
.next/
out/

# Misc
.DS_Store
*.tsbuildinfo
```

---

## 4. Step 1 — Update `convex.json` for All Environments

This is the **most critical code change** for deployment. The `convex.json` `authKit` section tells Convex how to auto-configure WorkOS for each environment. Currently we only have `dev` — we need to add `preview` and `prod`.

### How Convex-Managed WorkOS Works

This project uses a **Convex-managed WorkOS team** (set up via `@convex-dev/workos-authkit`). This means:

| What                                          | Who handles it                    |
| --------------------------------------------- | --------------------------------- |
| Creating WorkOS environments for dev          | **Convex** (automatic)            |
| Writing `WORKOS_*` vars to `.env.local`       | **Convex** (automatic, dev only)  |
| Creating AuthKit envs for prod/preview        | **You** (via Convex dashboard)    |
| Configuring redirect URIs / CORS in WorkOS    | **Convex** (automatic, all envs)  |
| Providing `WORKOS_*` to Next.js runtime       | **You** (via Vercel env vars)     |
| JWT validation in Convex backend              | **Convex** (via `auth.config.ts`) |

The `configure` block in `convex.json` is what tells Convex **what** to configure in WorkOS at deploy time. It uses template variables from the build environment.

### 4.1 Update `convex.json`

Replace the current `convex.json` with:

```json
{
  "authKit": {
    "dev": {
      "configure": {
        "redirectUris": ["http://localhost:3000/callback"],
        "appHomepageUrl": "http://localhost:3000",
        "corsOrigins": ["http://localhost:3000"]
      },
      "localEnvVars": {
        "WORKOS_CLIENT_ID": "${authEnv.WORKOS_CLIENT_ID}",
        "WORKOS_API_KEY": "${authEnv.WORKOS_API_KEY}",
        "NEXT_PUBLIC_WORKOS_REDIRECT_URI": "http://localhost:3000/callback"
      }
    },
    "preview": {
      "configure": {
        "redirectUris": ["https://${buildEnv.VERCEL_BRANCH_URL}/callback"],
        "appHomepageUrl": "https://${buildEnv.VERCEL_PROJECT_PRODUCTION_URL}",
        "corsOrigins": ["https://${buildEnv.VERCEL_BRANCH_URL}"]
      }
    },
    "prod": {
      "environmentType": "production",
      "configure": {
        "redirectUris": [
          "https://${buildEnv.VERCEL_PROJECT_PRODUCTION_URL}/callback"
        ],
        "appHomepageUrl": "https://${buildEnv.VERCEL_PROJECT_PRODUCTION_URL}",
        "corsOrigins": ["https://${buildEnv.VERCEL_PROJECT_PRODUCTION_URL}"]
      }
    }
  }
}
```

> **What the template variables mean:**
> - `${authEnv.WORKOS_CLIENT_ID}` — Resolved by Convex from the managed AuthKit environment (dev only)
> - `${buildEnv.VERCEL_BRANCH_URL}` — Provided by Vercel at build time (e.g., `my-branch-name.vercel.app`)
> - `${buildEnv.VERCEL_PROJECT_PRODUCTION_URL}` — Provided by Vercel at build time (e.g., `ptdom-crm.vercel.app` or your custom domain)

### 4.2 What happens at deploy time

When `npx convex deploy` runs (inside the Vercel build):

1. It reads the `authKit` section matching the deploy type (`prod` or `preview`)
2. It finds `WORKOS_CLIENT_ID` and `WORKOS_API_KEY` from the build environment (Vercel env vars) or the Convex deployment env vars
3. It uses the `WORKOS_API_KEY` to call the WorkOS API and **automatically configure**:
   - Redirect URIs (e.g., `https://ptdom-crm.vercel.app/callback`)
   - Allowed CORS origins
   - App homepage URL
4. It deploys your Convex functions (which use `WORKOS_CLIENT_ID` for JWT validation via `auth.config.ts`)
5. It then runs `pnpm build` (the Next.js build)

**You never manually touch the WorkOS dashboard for redirect URIs or CORS** — Convex does it for you every deploy.

---

## 5. Step 2 — Convex Production Setup

Your project already has a dev deployment (`dev:cautious-donkey-511`). Now you need a production deployment and AuthKit environments.

### 5.1 Verify your Convex project

```bash
# Opens the Convex dashboard for your project
npx convex dashboard
```

Confirm:
- Your project exists
- A development deployment is active
- A production deployment slot exists (created automatically with the project)

### 5.2 Create AuthKit environments via the Convex Dashboard

Since this is a Convex-managed WorkOS team, you create AuthKit environments **through the Convex dashboard**, not WorkOS directly.

#### Production AuthKit environment

1. Go to **Convex Dashboard** → your project
2. Switch to the **Production** deployment in the left sidebar
3. Go to **Settings** → **Integrations** → **WorkOS Authentication**
4. Click **"Create AuthKit Environment"**
5. This creates a production WorkOS environment and provides:
   - `WORKOS_CLIENT_ID` (same format: `client_01...`)
   - `WORKOS_API_KEY` (production format: `sk_live_...`)
6. **Copy both values** — you'll need them for Vercel env vars

#### Preview AuthKit environment (project-level)

1. In the Convex Dashboard → any deployment's **Settings** → **Integrations** → **WorkOS Authentication**
2. Create a **project-level** AuthKit environment
3. This single environment will be shared across all preview deployments
4. Copy the `WORKOS_CLIENT_ID` and `WORKOS_API_KEY` values

> **Why project-level?** Each preview deployment would otherwise need its own AuthKit environment. A shared project-level one is simpler and sufficient for QA/testing.

### 5.3 Generate deploy keys

You need **two** deploy keys — one for production, one for previews.

#### Production Deploy Key

1. Go to **Convex Dashboard** → your project → **Production deployment**
2. **Deployment Settings** → **General**
3. Click **"Generate Production Deploy Key"**
4. Copy the key (format: `prod:cautious-donkey-511|eyJ...`)

#### Preview Deploy Key

1. Go to **Convex Dashboard** → project-level **Settings**
2. Click **"Generate Preview Deploy Key"**
3. Copy the key (format: `preview:cautious-donkey-511|eyJ...`)

### 5.4 Set Convex production environment variables

These are the variables your **Convex backend functions** access via `process.env`.

In the **Convex Dashboard** → **Production deployment** → **Deployment Settings** → **Environment Variables**:

**Auto-set by AuthKit integration** (verify they exist):

| Variable                 | Value                                  | Notes                                    |
| ------------------------ | -------------------------------------- | ---------------------------------------- |
| `WORKOS_CLIENT_ID`       | `client_01...` (from AuthKit env)      | Auto-set when AuthKit env is created     |
| `WORKOS_API_KEY`         | `sk_live_...` (from AuthKit env)       | Auto-set when AuthKit env is created     |
| `WORKOS_ENVIRONMENT_ID`  | `environment_01...` (from AuthKit env) | Auto-set when AuthKit env is created     |

**Must set manually** (mirror what's on your dev deployment):

| Variable                       | Value                                  | Notes                                    |
| ------------------------------ | -------------------------------------- | ---------------------------------------- |
| `CALENDLY_CLIENT_ID`           | Your Calendly OAuth client ID          | For server-side Calendly API calls       |
| `CALENDLY_CLIENT_SECRET`       | Your Calendly OAuth secret             | For server-side token refresh            |
| `CALENDLY_WEBHOOK_SIGNING_KEY` | (from Calendly webhook config)         | Verifies incoming webhook signatures     |
| `INVITE_SIGNING_SECRET`        | (strong random secret, ≥32 chars)      | Signs/verifies tenant invite tokens      |
| `WORKOS_WEBHOOK_SECRET`        | (from WorkOS webhook config)           | Verifies incoming WorkOS webhook events  |
| `NEXT_PUBLIC_APP_URL`          | `https://yourdomain.com`               | **Critical**: used in Convex functions to build Calendly OAuth redirect URI. Defaults to `http://localhost:3000` if unset — will break in production |

> **Tip**: Generate secrets with `openssl rand -base64 32`

> **Verify with**:
> ```bash
> CONVEX_DEPLOY_KEY="prod:your-key" npx convex env list
> ```
>
> You should see all 9 variables listed above.

### 5.5 Access environment variables in Convex functions

```typescript
// In any Convex function:
const apiKey = process.env.WORKOS_API_KEY;
// Returns string if set, undefined if not

// For required variables, validate early:
if (!apiKey) throw new Error("WORKOS_API_KEY not configured");
```

> **⚠️ Critical**: Do NOT condition function exports on environment variables. The callable function set is determined at deploy time, not at runtime.

---

## 6. Step 3 — Vercel Project Setup

### 6.1 Create the Vercel project

**Option A — Via Vercel Dashboard (recommended for first time):**

1. Go to [vercel.com/new](https://vercel.com/new)
2. Click **"Import Git Repository"**
3. Select your GitHub account → find `ptdom-crm`
4. Configure the project:

| Setting              | Value                                       |
| -------------------- | ------------------------------------------- |
| **Project Name**     | `ptdom-crm` (or your preferred name)        |
| **Framework Preset** | Next.js (auto-detected)                     |
| **Root Directory**   | `./` (default)                              |
| **Build Command**    | `npx convex deploy --cmd 'pnpm build'`      |
| **Output Directory** | `.next` (default, leave blank)              |
| **Install Command**  | `pnpm install` (auto-detected from lockfile)|

5. Add environment variables (see Step 3 below) **before clicking Deploy**
6. Click **Deploy**

**Option B — Via Vercel CLI:**

```bash
# Install Vercel CLI
pnpm add -g vercel

# Link project
vercel link

# Set the build command override
# (done in project settings after linking)
```

### 6.2 Configure build settings

The **build command** is the most critical setting. In Vercel project settings → **General** → **Build & Development Settings**:

| Setting            | Value                                                |
| ------------------ | ---------------------------------------------------- |
| Build Command      | `npx convex deploy --cmd 'pnpm build'`               |
| Output Directory   | (leave default)                                      |
| Install Command    | `pnpm install`                                       |
| Development Command| `pnpm dev`                                           |
| Node.js Version    | 20.x (match your local version)                     |

> **How this works**: `npx convex deploy` reads `CONVEX_DEPLOY_KEY` from the environment, pushes your Convex functions to the correct deployment, sets `CONVEX_URL` for the Next.js build, then runs `pnpm build`.

### 6.3 Configure production branch

In **Vercel Project Settings** → **Environments** → **Production**:

1. Click on **Branch Tracking**
2. Ensure it's set to `main`
3. This means: pushes to `main` → production deployment

---

## 7. Step 4 — Environment Variables (Complete Matrix)

> **⚠️ CURRENT BLOCKERS — Read Before Setting Env Vars**
>
> The following variables **cannot be set yet** because we do not have a production domain (no domain purchased, and Vercel has not yet been deployed):
>
> | Variable                | Why it's blocked                                                                 |
> | ----------------------- | -------------------------------------------------------------------------------- |
> | `WORKOS_WEBHOOK_SECRET` | Requires the production WorkOS environment to be fully set up first              |
> | `NEXT_PUBLIC_APP_URL`   | Requires knowing the production domain (Vercel-assigned or custom). Used in Convex functions to build Calendly OAuth redirect URI — will remain `http://localhost:3000` fallback until set |
>
> **Once Vercel is deployed** (even without a custom domain), the Vercel-assigned `*.vercel.app` URL can be used as a temporary production URL. These two variables should be set immediately after.

### How Credentials Flow in This Architecture

Understanding this flow is critical:

```
┌─────────────────────────────────────────────────────────┐
│  Convex Dashboard (AuthKit Integration)                  │
│  Creates WorkOS environment → provides CLIENT_ID + API_KEY│
└───────┬─────────────────────────────┬───────────────────┘
        │                             │
        ▼                             ▼
┌───────────────────┐    ┌─────────────────────────────┐
│ Convex Deployment │    │ Vercel Environment Variables  │
│ Environment Vars  │    │ (you copy them here)          │
│                   │    │                               │
│ Used by:          │    │ Used by:                      │
│ • auth.config.ts  │    │ • Next.js authkit middleware   │
│   (JWT validation)│    │ • npx convex deploy (build)   │
│ • Convex functions│    │   (auto-configures WorkOS)    │
│   (process.env)   │    │ • Next.js runtime (cookies)   │
└───────────────────┘    └─────────────────────────────┘
```

- **Convex deployment env vars**: Used by your backend functions and `auth.config.ts`
- **Vercel env vars**: Used by the Next.js runtime (authkit-nextjs middleware) AND by `npx convex deploy` at build time to auto-configure WorkOS

### Vercel Environment Variables

Set in **Vercel Dashboard** → **Project Settings** → **Environment Variables**.

> **Key concept**: Each variable is scoped to one or more environments: **Production**, **Preview**, **Development**. The same variable name can have **different values** per scope.

#### `CONVEX_DEPLOY_KEY` — Different per environment

| Scope          | Value                                | Source                              |
| -------------- | ------------------------------------ | ----------------------------------- |
| **Production** | `prod:cautious-donkey-511\|eyJ...`   | Convex Dashboard → Prod Deployment Settings → General |
| **Preview**    | `preview:cautious-donkey-511\|eyJ...`| Convex Dashboard → Project Settings |

> **⚠️ Do NOT set for Development** — local dev uses `CONVEX_DEPLOYMENT` from `.env.local`.

**How to set scoped variables in Vercel:**
1. Go to Environment Variables
2. Add `CONVEX_DEPLOY_KEY` with the **production** key → check only **Production** → Save
3. Add `CONVEX_DEPLOY_KEY` again with the **preview** key → check only **Preview** → Save

#### `WORKOS_*` Variables — From Convex Dashboard AuthKit environments

| Variable                             | Production (from prod AuthKit env)  | Preview (from project AuthKit env) | Source |
| ------------------------------------ | ----------------------------------- | ---------------------------------- | ------ |
| `WORKOS_CLIENT_ID`                   | `client_01...`                      | `client_01...` (may differ)        | Convex Dashboard → AuthKit Integration |
| `WORKOS_API_KEY`                     | `sk_live_...`                       | `sk_test_...`                      | Convex Dashboard → AuthKit Integration |
| `WORKOS_COOKIE_PASSWORD`             | (32+ char strong password)          | (different password)               | You generate: `openssl rand -base64 24` |

> **Why are these needed in Vercel if Convex manages WorkOS?** Because `@workos-inc/authkit-nextjs` (the Next.js middleware) runs in Vercel's runtime, not Convex. It needs `WORKOS_API_KEY` to manage sessions, and `WORKOS_CLIENT_ID` for token validation. Convex can't inject these into the Next.js server at runtime.

#### All Vercel Environment Variables — Complete

| Variable                             | Production                    | Preview                  | Dev  | Notes                               |
| ------------------------------------ | ----------------------------- | ------------------------ | ---- | ----------------------------------- |
| `CONVEX_DEPLOY_KEY`                  | `prod:...\|eyJ...`            | `preview:...\|eyJ...`    | —    | **Different values per env**        |
| `WORKOS_CLIENT_ID`                   | `client_01...` (prod)         | `client_01...` (preview) | —    | From Convex AuthKit integration     |
| `WORKOS_API_KEY`                     | `sk_live_...`                 | `sk_test_...`            | —    | From Convex AuthKit integration     |
| `WORKOS_COOKIE_PASSWORD`             | (32+ char password)           | (different password)     | —    | You generate; ≥32 chars             |
| `NEXT_PUBLIC_WORKOS_REDIRECT_URI`    | `https://yourdomain.com/callback` | `https://${VERCEL_BRANCH_URL}/callback` | — | Read at runtime by `app/callback/route.ts` |
| `NEXT_PUBLIC_CALENDLY_CLIENT_ID`     | Your Calendly client ID       | same                     | —    |                                     |
| `CALENDLY_CLIENT_SECRET`             | Your Calendly secret          | same or test             | —    | Server-side only                    |
| `NEXT_PUBLIC_APP_URL`                | `https://yourdomain.com`      | `https://${VERCEL_BRANCH_URL}` | — | Used in Convex fns for Calendly OAuth redirect URI |
| `SYSTEM_ADMIN_ORG_ID`                | `org_01...` (same across envs)| same                           | — | WorkOS org ID for system admin; used by sign-in/sign-up routes and page guards |

> **Note on `NEXT_PUBLIC_WORKOS_REDIRECT_URI`**: While the `convex.json` `configure` block auto-configures redirect URIs in WorkOS itself, the Next.js app also reads this variable at runtime in `app/callback/route.ts` to construct the callback URL. You **must** set it in Vercel for each scope. For preview, you can use Vercel's built-in `VERCEL_BRANCH_URL` to construct the value dynamically, or set a sensible default.

> **Note on `NEXT_PUBLIC_APP_URL`**: This is used in **two places in Convex functions** (`convex/admin/tenants.ts` and `convex/calendly/oauth.ts`) to construct the Calendly OAuth redirect URI. Since Convex functions can't read Vercel env vars, this means you also need to set it as a **Convex deployment env var** (see below). In the Next.js side it defaults to `http://localhost:3000` — for production you must set the real domain.

**Variables you do NOT need to set in Vercel:**

| Variable                             | Why not                                                          |
| ------------------------------------ | ---------------------------------------------------------------- |
| `NEXT_PUBLIC_CONVEX_URL`             | Auto-set by `npx convex deploy` during the build                |
| `NEXT_PUBLIC_CONVEX_SITE_URL`        | Auto-set by `npx convex deploy` during the build                |

### Convex Environment Variables (Backend)

Set in the **Convex Dashboard** for each deployment, or managed automatically via the AuthKit integration.

#### Production Deployment

| Variable                       | Value                               | How it's set                        | Used by                             |
| ------------------------------ | ----------------------------------- | ----------------------------------- | ----------------------------------- |
| `WORKOS_CLIENT_ID`             | `client_01...`                      | Auto-set from AuthKit integration   | `auth.config.ts`, admin, workos fns |
| `WORKOS_API_KEY`               | `sk_live_...`                       | Auto-set from AuthKit integration   | WorkOS SDK calls in actions         |
| `WORKOS_ENVIRONMENT_ID`        | `environment_01...`                 | Auto-set from AuthKit integration   | WorkOS environment identifier       |
| `WORKOS_WEBHOOK_SECRET`        | (from WorkOS webhook setup)         | Manual: `npx convex env set`        | Webhook signature verification      |
| `CALENDLY_CLIENT_ID`           | Your production Calendly ID         | Manual: `npx convex env set`        | `calendly/oauth.ts`, `tokens.ts`    |
| `CALENDLY_CLIENT_SECRET`       | Your production Calendly secret     | Manual: `npx convex env set`        | `calendly/oauth.ts`, `tokens.ts`    |
| `CALENDLY_WEBHOOK_SIGNING_KEY` | (from Calendly webhook setup)       | Manual: `npx convex env set`        | Webhook signature verification      |
| `INVITE_SIGNING_SECRET`        | (strong random secret)              | Manual: `npx convex env set`        | `admin/tenants.ts`, `onboarding/invite.ts` |
| `NEXT_PUBLIC_APP_URL`          | `https://yourdomain.com`            | Manual: `npx convex env set`        | `admin/tenants.ts`, `calendly/oauth.ts` — constructs Calendly redirect URI |
| `SYSTEM_ADMIN_ORG_ID`          | `org_01...` (your WorkOS org ID)    | Manual: `npx convex env set`        | `convex/lib/constants.ts` → `requireSystemAdmin.ts`, sign-in/sign-up routes — identifies the system admin organization |

> **Important**: `NEXT_PUBLIC_APP_URL` is misleadingly named — it's used server-side in Convex functions to build the Calendly OAuth redirect callback URL. Despite the `NEXT_PUBLIC_` prefix, it **must** be set as a Convex deployment env var for production because Convex functions can't read Vercel env vars. It currently defaults to `http://localhost:3000` if unset, which will break Calendly OAuth in production.

#### Dev Deployment (current state for reference)

| Variable                       | Value                               | How it's set                        |
| ------------------------------ | ----------------------------------- | ----------------------------------- |
| `WORKOS_CLIENT_ID`             | `client_01...`                      | Auto-set from AuthKit integration   |
| `WORKOS_API_KEY`               | `sk_test_...`                       | Auto-set from AuthKit integration   |
| `WORKOS_ENVIRONMENT_ID`        | `environment_01...`                 | Auto-set from AuthKit integration   |
| `WORKOS_WEBHOOK_SECRET`        | (from WorkOS webhook setup)         | Manual                              |
| `CALENDLY_CLIENT_ID`           | Same or test ID                     | Manual                              |
| `CALENDLY_CLIENT_SECRET`       | Same or test secret                 | Manual                              |
| `CALENDLY_WEBHOOK_SIGNING_KEY` | (from Calendly webhook setup)       | Manual                              |
| `INVITE_SIGNING_SECRET`        | (strong random secret)              | Manual                              |
| `SYSTEM_ADMIN_ORG_ID`          | `org_01...` (your WorkOS org ID)    | Manual                              |

> **Note**: The dev deployment does NOT currently have `NEXT_PUBLIC_APP_URL` set — the code falls back to `http://localhost:3000`. For production, this fallback will be incorrect.

#### System Variables (automatically available — do not set)

| Variable            | Description                                |
| ------------------- | ------------------------------------------ |
| `CONVEX_CLOUD_URL`  | Your deployment URL (for Convex clients)   |
| `CONVEX_SITE_URL`   | Your HTTP Actions URL (for webhooks, etc.) |

### Local Development (`.env.local`)

Here is the actual current `.env.local` with annotations:

```env
# ── Convex (auto-set by npx convex dev) ──────────────────
CONVEX_DEPLOYMENT=dev:cautious-donkey-511
NEXT_PUBLIC_CONVEX_URL=https://cautious-donkey-511.convex.cloud
NEXT_PUBLIC_CONVEX_SITE_URL=https://cautious-donkey-511.convex.site

# ── WorkOS (auto-set by Convex-managed AuthKit via localEnvVars) ──
WORKOS_CLIENT_ID=<auto-provisioned>
WORKOS_API_KEY=<auto-provisioned: sk_test_...>
NEXT_PUBLIC_WORKOS_REDIRECT_URI=http://localhost:3000/callback

# ── WorkOS (MANUAL — not auto-provisioned) ───────────────
WORKOS_COOKIE_PASSWORD=<your-32-char-password>

# ── Calendly (MANUAL) ────────────────────────────────────
NEXT_PUBLIC_CALENDLY_CLIENT_ID=<your-calendly-client-id>

# ── App (MANUAL) ─────────────────────────────────────────
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

**What's NOT in `.env.local` but IS in the Convex dev deployment:**

These server-side-only variables are set directly on the Convex deployment (via dashboard or `npx convex env set`) and are not needed in `.env.local`:

- `CALENDLY_CLIENT_ID` — server-side Calendly OAuth
- `CALENDLY_CLIENT_SECRET` — server-side token refresh
- `CALENDLY_WEBHOOK_SIGNING_KEY` — webhook signature verification
- `INVITE_SIGNING_SECRET` — tenant invite token signing
- `WORKOS_ENVIRONMENT_ID` — WorkOS environment reference
- `WORKOS_WEBHOOK_SECRET` — WorkOS webhook verification

> **⚠️ Never commit `.env.local`** — it's in `.gitignore`.

---

## 8. Step 5 — WorkOS: What Convex Manages vs What You Manage

### The Big Picture

Because this project uses a **Convex-managed WorkOS team**, the WorkOS configuration model is different from a standard WorkOS setup:

| Task                                        | Standard WorkOS    | Convex-Managed WorkOS          |
| ------------------------------------------- | ------------------ | ------------------------------ |
| Create WorkOS environments                  | WorkOS dashboard   | **Convex dashboard**           |
| Configure redirect URIs                     | WorkOS dashboard   | **Automatic** (via `convex.json`) |
| Configure CORS origins                      | WorkOS dashboard   | **Automatic** (via `convex.json`) |
| Get `WORKOS_CLIENT_ID` / `WORKOS_API_KEY`   | WorkOS dashboard   | **Convex dashboard** (AuthKit integration) |
| Set env vars for Next.js runtime            | Manual             | **Manual** (copy to Vercel)    |
| JWT validation in Convex backend            | Manual config      | **Automatic** (`auth.config.ts` + env vars) |

### What you do NOT need to do

- ❌ Go to `dashboard.workos.com` to configure redirect URIs
- ❌ Go to `dashboard.workos.com` to set up CORS origins
- ❌ Go to `dashboard.workos.com` to configure the app homepage URL
- ❌ Manually maintain different redirect URIs as your Vercel URLs change

**Convex handles all of this** at deploy time via the `configure` block in `convex.json`.

### What you DO need to do

1. **Create AuthKit environments** in the Convex dashboard (one for prod, one project-level for preview) — Step 5.2
2. **Copy credentials** (`WORKOS_CLIENT_ID`, `WORKOS_API_KEY`) from Convex dashboard to Vercel env vars — Step 7
3. **Generate `WORKOS_COOKIE_PASSWORD`** (≥32 chars) and set it in Vercel — Step 7
4. **Keep `convex.json`** updated with the correct `configure` blocks for each environment — Step 4.1

### `auth.config.ts` — No Changes Needed

Your `convex/auth.config.ts` already works across all environments because it reads `WORKOS_CLIENT_ID` from `process.env` (Convex deployment env vars), which differs per deployment:

```typescript
// convex/auth.config.ts — works as-is for dev, preview, and prod
const clientId = process.env.WORKOS_CLIENT_ID;

const authConfig = {
  providers: [
    {
      type: "customJwt" as const,
      issuer: "https://api.workos.com/",
      algorithm: "RS256" as const,
      jwks: `https://api.workos.com/sso/jwks/${clientId}`,
      applicationID: clientId,
    },
    {
      type: "customJwt" as const,
      issuer: `https://api.workos.com/user_management/${clientId}`,
      algorithm: "RS256" as const,
      jwks: `https://api.workos.com/sso/jwks/${clientId}`,
    },
  ],
};

export default authConfig;
```

### Validation Checklist

- [ ] Production AuthKit env created in Convex dashboard (provides `sk_live_...` key)
- [ ] Preview AuthKit env created in Convex dashboard (provides `sk_test_...` key)
- [ ] `WORKOS_CLIENT_ID` and `WORKOS_API_KEY` copied to Vercel for **Production** scope
- [ ] `WORKOS_CLIENT_ID` and `WORKOS_API_KEY` copied to Vercel for **Preview** scope
- [ ] `WORKOS_COOKIE_PASSWORD` generated and set in Vercel for both scopes (≥32 chars)
- [ ] `convex.json` has `preview` and `prod` sections with correct `configure` blocks
- [ ] Test a full sign-up → sign-in → sign-out flow on a preview deployment first

---

## 9. Step 6 — Calendly OAuth Production Configuration

The app uses Calendly OAuth for tenant integration. This needs production configuration.

### 9.1 Calendly Developer Portal

1. Go to [developer.calendly.com](https://developer.calendly.com)
2. Select your OAuth application

### 9.2 Configure OAuth Redirect URIs

Add your production callback URL:

| Environment | Redirect URI                                          |
| ----------- | ----------------------------------------------------- |
| Local dev   | `http://localhost:3000/callback/calendly` (existing)  |
| Production  | `https://yourdomain.com/callback/calendly`            |
| Preview     | `https://*.vercel.app/callback/calendly` (if supported) |

> Check if Calendly supports wildcard redirect URIs. If not, preview deployments may need individual URIs or a different OAuth flow.

### 9.3 Webhook Configuration

Calendly webhooks are provisioned per-tenant via the API (see `convex/calendly/`). For production:

1. **Webhook URL**: The Convex HTTP Action endpoint for webhooks
   - Production: `https://<your-prod-deployment>.convex.site/calendly/webhook`
   - This is the `CONVEX_SITE_URL` of your production Convex deployment
2. **Webhook signing key**: Verify webhook signatures in production
3. **Retry handling**: Calendly retries failed webhooks — ensure idempotent processing

### 9.4 Calendly Environment Variables

Ensure these are set in both Convex (for server-side OAuth token management) and Vercel (for the frontend OAuth initiation flow):

| Where  | Variable                        | Production Value            |
| ------ | ------------------------------- | --------------------------- |
| Vercel | `NEXT_PUBLIC_CALENDLY_CLIENT_ID` | Your Calendly client ID    |
| Vercel | `CALENDLY_CLIENT_SECRET`        | Your Calendly secret        |
| Convex | `CALENDLY_CLIENT_ID`            | Your Calendly client ID    |
| Convex | `CALENDLY_CLIENT_SECRET`        | Your Calendly secret        |

### 9.5 Production Considerations

- **Rate limits**: Calendly API has rate limits. Implement exponential backoff in `convex/calendly/` functions.
- **Token refresh**: Ensure OAuth token refresh works in production (tokens expire).
- **Webhook reliability**: Monitor `rawWebhookEvents` table for failed processing.

---

## 10. Step 7 — Custom Domain Setup

> **📌 No domain purchased yet.** This entire step is deferred until a domain is acquired. In the meantime, the Vercel-assigned `*.vercel.app` URL can serve as the production URL for initial deployment and testing.

### 10.1 Vercel Custom Domain

1. In **Vercel Dashboard** → **Project Settings** → **Domains**
2. Add your domain: `yourdomain.com`
3. Vercel provides DNS records to configure:

| Type  | Name  | Value                          |
| ----- | ----- | ------------------------------ |
| CNAME | `www` | `cname.vercel-dns.com`         |
| A     | `@`   | `76.76.21.21`                  |

4. Configure in your DNS provider (e.g., Cloudflare, Namecheap, Route53)
5. Wait for DNS propagation (can take up to 48 hours, usually minutes)
6. Vercel auto-provisions SSL certificate

### 10.2 Verify Domain

```bash
# Check DNS propagation
dig yourdomain.com +short
# Should return Vercel's IP

# Or use Vercel CLI
vercel domains inspect yourdomain.com
```

### 10.3 Update Services After Domain Setup

Once your custom domain is live, update these:

| Service       | What to update                            | New value                              | Auto? |
| ------------- | ----------------------------------------- | -------------------------------------- | ----- |
| **Vercel**    | `NEXT_PUBLIC_APP_URL`                     | `https://yourdomain.com`              | No — manual |
| **WorkOS**    | Redirect URIs, CORS, homepage             | `https://yourdomain.com/callback`     | **Yes** — auto-configured by Convex via `convex.json` on next deploy |
| **Calendly**  | OAuth Redirect URI                        | `https://yourdomain.com/callback/calendly` | No — manual in Calendly dev portal |

> **Note**: After adding a custom domain, Vercel sets `VERCEL_PROJECT_PRODUCTION_URL` to your custom domain. The `convex.json` `configure` block uses `${buildEnv.VERCEL_PROJECT_PRODUCTION_URL}`, so WorkOS redirect URIs update automatically on the next deployment. You do NOT need to touch WorkOS manually.

---

## 11. Step 8 — First Production Deployment

With everything configured, here's the first deploy:

### 11.1 Deploy Convex functions first (optional — Vercel build does this)

```bash
# If you want to manually deploy Convex before Vercel:
CONVEX_DEPLOY_KEY="prod:your-key" npx convex deploy

# Verify:
CONVEX_DEPLOY_KEY="prod:your-key" npx convex env list
```

### 11.2 Trigger the Vercel production deploy

```bash
# Ensure main branch is up to date
git checkout main
git pull origin main

# Push to trigger production deployment
git push origin main

# OR: merge a PR from dev → main on GitHub
# This triggers Vercel's automatic deployment
```

### 11.3 Monitor the deployment

1. **Vercel Dashboard** → **Deployments** → watch the build log
2. Verify: `npx convex deploy --cmd 'pnpm build'` runs successfully
3. The build log should show:
   - Convex functions deployed to production ✅
   - Next.js build completed ✅
   - Deployment published ✅

### 11.4 Post-deployment verification

```
Smoke Test Checklist:
─────────────────────
[ ] Homepage loads at yourdomain.com
[ ] Sign-up flow works (WorkOS AuthKit)
[ ] Sign-in flow works (redirect + callback)
[ ] Convex real-time subscriptions work (data appears)
[ ] Calendly OAuth flow works (connect account)
[ ] Webhook processing works (create test event)
[ ] Team member management works
[ ] Pipeline/opportunities table loads
[ ] Sign-out works and redirects correctly
[ ] HTTPS is enforced (no mixed content)
[ ] No console errors in browser DevTools
```

---

## 12. Deployment Environments

### Environment Summary

| Aspect              | Development (local)           | Preview (PRs / `dev`)                   | Production (`main`)                |
| ------------------- | ----------------------------- | --------------------------------------- | ---------------------------------- |
| **Frontend**        | `localhost:3000`              | `*.vercel.app` (auto)                   | `yourdomain.com`                   |
| **Convex backend**  | `dev:cautious-donkey-511`     | Fresh deployment per branch             | Production deployment              |
| **Convex data**     | Personal dev data             | Empty (fresh per preview)               | Real user data                     |
| **WorkOS**          | Auto-provisioned by Convex    | Project-level AuthKit env (`sk_test_`)  | Production AuthKit env (`sk_live_`)  |
| **WorkOS config**   | Auto via `convex.json` `dev`  | Auto via `convex.json` `preview`        | Auto via `convex.json` `prod`      |
| **Calendly**        | Sandbox / test account        | Sandbox / test account                  | Production OAuth app               |
| **Deploy trigger**  | Manual (`pnpm dev`)           | Push to any non-`main` branch           | Push / merge to `main`             |
| **Deploy key**      | `CONVEX_DEPLOYMENT` in .env   | Preview deploy key in Vercel            | Production deploy key in Vercel    |

### How Convex Preview Deployments Work

When you push to any branch other than `main`:
1. Vercel starts a preview build
2. `npx convex deploy` reads the **preview** `CONVEX_DEPLOY_KEY`
3. Convex creates a **fresh, isolated deployment** for that Git branch
4. The deployment gets its own database (empty by default)
5. The frontend build points to this isolated backend
6. Each branch reuses its deployment on subsequent pushes

> **Preview deployments have no data.** To seed data, use `--preview-run`:
> ```
> npx convex deploy --cmd 'pnpm build' --preview-run 'seedData'
> ```
> Where `seedData` is a Convex function that inserts test data.

---

## 13. CI/CD — How It All Connects

### Automatic Deployment Flow

```
Developer pushes code
        │
        ▼
GitHub receives push
        │
        ├── Push to `main` ──────────────────────────────┐
        │                                                 │
        │   Vercel: Production deployment                 │
        │   1. pnpm install                               │
        │   2. npx convex deploy --cmd 'pnpm build'       │
        │      → Reads CONVEX_DEPLOY_KEY (production)     │
        │      → Pushes functions to Convex production    │
        │      → Sets CONVEX_URL for the build            │
        │      → Runs pnpm build (Next.js)                │
        │   3. Deploys to yourdomain.com                  │
        │                                                 │
        ├── Push to `dev` or feature branch ─────────────┐
        │                                                 │
        │   Vercel: Preview deployment                    │
        │   1. pnpm install                               │
        │   2. npx convex deploy --cmd 'pnpm build'       │
        │      → Reads CONVEX_DEPLOY_KEY (preview)        │
        │      → Creates/reuses preview Convex deployment │
        │      → Sets CONVEX_URL for the build            │
        │      → Runs pnpm build (Next.js)                │
        │   3. Deploys to unique *.vercel.app URL         │
        │                                                 │
        └── PR opened / updated ─────────────────────────┐
                                                          │
            Vercel posts deployment URL as PR comment      │
            Reviewers can test the exact changes           │
```

### No separate CI/CD pipeline needed

Because the Vercel build command (`npx convex deploy --cmd 'pnpm build'`) handles both Convex and Next.js deployment, you do **not** need GitHub Actions or any other CI system for deployments. Vercel handles everything.

However, you may want GitHub Actions for:
- Running tests on PR
- Linting checks
- Type checking

Example `.github/workflows/ci.yml` (optional):

```yaml
name: CI
on:
  pull_request:
    branches: [dev, main]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: npx tsc --noEmit
```

---

## 14. Rollback Procedures

### Frontend Rollback (Vercel)

Vercel keeps every deployment immutable. To rollback:

**Option A — Instant rollback via dashboard:**
1. Go to **Vercel Dashboard** → **Deployments**
2. Find the last known-good deployment
3. Click **"..."** → **"Promote to Production"**
4. Production instantly serves the old version

**Option B — Git revert:**
```bash
git checkout main
git revert HEAD     # Creates a new commit undoing the last merge
git push origin main
# Vercel auto-deploys the reverted state
```

### Backend Rollback (Convex)

Convex does **not** have instant rollback. Options:

**Option A — Re-deploy previous Convex functions:**
```bash
# Checkout the previous good commit
git checkout <good-commit-hash>

# Deploy just Convex functions
CONVEX_DEPLOY_KEY="prod:your-key" npx convex deploy

# Go back to main
git checkout main
```

**Option B — Fix forward:**
- Push a fix to `dev`, test it, merge to `main`
- This is usually faster than trying to rollback

**Option C — Data restore (extreme cases):**
- Convex provides daily automatic backups
- Contact Convex support for data restoration
- This is a last resort — data written after the backup is lost

### Schema Rollback Considerations

> **⚠️ Convex schema must always match existing data.** You cannot simply revert a schema change if data was already written with the new schema. See [Schema Safety](#15-convex-schema-safety--migrations).

---

## 15. Convex Schema Safety & Migrations

### Golden Rule

> **Schema must always match existing data.** A deployment will fail if the schema doesn't describe the data that already exists in the database.

### Safe Schema Changes (no migration needed)

| Change                                | Why it's safe                                    |
| ------------------------------------- | ------------------------------------------------ |
| Adding a new table                    | No existing data to conflict                     |
| Adding an optional field (`v.optional(...)`) | Existing docs without the field are still valid |
| Adding a new index                    | Indexes build automatically                      |
| Widening a field type via union       | `v.union(v.string(), v.number())` — old data matches |

### Unsafe Schema Changes (require migration)

| Change                          | Why it's unsafe                            | Solution                                |
| ------------------------------- | ------------------------------------------ | --------------------------------------- |
| Removing a field                | Existing docs still have it                | Backfill removal first, then update schema |
| Changing a field type           | Existing data is old type                  | Widen → migrate → narrow                |
| Making optional field required  | Existing docs might lack it                | Backfill first, then make required      |
| Removing a table                | Only safe if table is empty                | Delete all docs first                   |
| Removing an index               | Safe (no data dependency)                  | Just remove it                          |

### Migration Strategy: Widen → Migrate → Narrow

For non-trivial schema changes, use the three-phase approach:

```
Phase 1: WIDEN
  - Update schema to accept BOTH old and new formats
  - Deploy: npx convex deploy
  - Example: v.union(v.string(), v.number()) for a field changing from string to number

Phase 2: MIGRATE
  - Run a migration function to convert existing data to new format
  - Use @convex-dev/migrations component or a manual mutation
  - Verify all data is migrated

Phase 3: NARROW
  - Update schema to only accept the new format
  - Deploy: npx convex deploy
  - Old format is no longer accepted
```

### Backward Compatibility for Functions

When deploying new function versions:
- **Safe**: Adding new functions, adding optional parameters, expanding argument types
- **Unsafe**: Removing functions that clients may still call, changing required parameters
- **Scheduled functions**: Always ensure new versions accept arguments from previously scheduled invocations

---

## 16. Monitoring & Observability

### Vercel Dashboard

| What to monitor            | Where                                   | Alert threshold               |
| -------------------------- | --------------------------------------- | ----------------------------- |
| Build status               | Deployments tab                         | Any failure                   |
| Core Web Vitals (LCP, CLS) | Analytics → Web Vitals                 | LCP > 2.5s, CLS > 0.1        |
| Error rate (5xx)           | Logs → filter by status                | Any 5xx in production         |
| Function execution time    | Logs → Function tab                    | > 10s execution               |
| Bandwidth usage            | Usage tab                               | Approaching plan limit        |

### Convex Dashboard

| What to monitor            | Where                                   | Alert threshold               |
| -------------------------- | --------------------------------------- | ----------------------------- |
| Function errors            | Logs tab                                | Any errors                    |
| Slow queries               | Functions → select function → Insights  | > 500ms                       |
| Database size              | Data tab → table sizes                  | Approaching plan limit        |
| Document reads/writes      | Functions → Insights                    | Unexpectedly high counts      |
| Scheduler queue            | Functions → Scheduled                   | Growing queue backlog         |

### Recommended Third-Party Tools (Future)

| Tool         | Purpose                              | Priority |
| ------------ | ------------------------------------ | -------- |
| **Sentry**   | Frontend error tracking & alerting   | High     |
| **LogRocket**| Session replay for debugging         | Medium   |
| **Checkly**  | Uptime monitoring & synthetic checks | Medium   |
| **PagerDuty**| Incident alerting                    | Low (for now) |

### Key Logs Commands

```bash
# Convex production logs (requires deploy key)
CONVEX_DEPLOY_KEY="prod:your-key" npx convex logs

# Convex dev logs
npx convex logs

# Vercel logs (via CLI)
vercel logs yourdomain.com --follow
```

---

## 17. Security Best Practices

### Secrets Management

| ✅ Do                                        | ❌ Don't                                    |
| -------------------------------------------- | ------------------------------------------- |
| Store secrets in Vercel/Convex dashboards    | Commit `.env` files to Git                  |
| Use different keys for dev/prod              | Use same API keys across environments       |
| Rotate API keys quarterly                    | Share keys via Slack/email                  |
| Enable 2FA on all service dashboards         | Hardcode secrets in client-side code        |
| Use `WORKOS_API_KEY` server-side only        | Expose `WORKOS_API_KEY` to the browser      |
| Prefix public vars with `NEXT_PUBLIC_`       | Put server secrets in `NEXT_PUBLIC_` vars   |

### Convex-Specific Security

From the Convex best practices docs:

1. **Validate all arguments**: Use `args` validators on every public function
2. **Authenticate every function**: Check `ctx.auth.getUserIdentity()` in all public queries/mutations
3. **Don't trust client-provided identity**: Never use email from args for access control — use `ctx.auth`
4. **Mark internal functions as `internal`**: They can only be called by other Convex functions
5. **Use `ctx.runQuery/Mutation` only for internal functions**: Never expose internal functions to clients

### Security Headers

Add to `next.config.ts` or `vercel.json`:

```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "X-Frame-Options", "value": "DENY" },
        { "key": "X-XSS-Protection", "value": "1; mode=block" },
        { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" },
        { "key": "Strict-Transport-Security", "value": "max-age=63072000; includeSubDomains; preload" }
      ]
    }
  ]
}
```

### Access Control

| Service   | Who has access                       | How to restrict                          |
| --------- | ------------------------------------ | ---------------------------------------- |
| GitHub    | Team members                         | Require 2FA, branch protections          |
| Vercel    | Team admins only for prod settings   | Role-based access in Vercel team         |
| Convex    | Team members via Convex dashboard    | Limit production access to admins        |
| WorkOS    | Application admins                   | Dashboard access controls                |

---

## 18. Scaling & Performance

### Frontend (Vercel) — Mostly Automatic

| Optimization                  | Status        | Action needed                      |
| ----------------------------- | ------------- | ---------------------------------- |
| Global CDN                    | ✅ Automatic  | None                               |
| Static page caching           | ✅ Automatic  | None                               |
| Image optimization            | ✅ Automatic  | Use `<Image>` component            |
| Edge Functions                | Available     | Move latency-sensitive routes      |
| ISR (Incremental Static Regen)| Available     | Add `revalidate` to static pages   |

### Backend (Convex) — Optimize Queries

Run before going to production:

```bash
npx convex insights
```

**Common optimizations:**

1. **Use indexes instead of `.filter()`**: Replace `.filter()` with `.withIndex()` for any query scanning > 100 documents
2. **Avoid `.collect()` on large tables**: Use `.take(n)` or pagination
3. **Remove redundant indexes**: If you have `by_foo` and `by_foo_and_bar`, remove `by_foo`
4. **Await all promises**: Enable `no-floating-promises` ESLint rule
5. **Batch mutations**: Use single mutations for related operations instead of multiple `ctx.runMutation` calls
6. **Avoid `Date.now()` in queries**: Use scheduled functions to set timestamp flags on documents instead

---

## 19. Troubleshooting

### Build Fails on Vercel

| Symptom                               | Likely cause                          | Fix                                       |
| ------------------------------------- | ------------------------------------- | ----------------------------------------- |
| `CONVEX_DEPLOY_KEY is not set`        | Missing env var in Vercel             | Add the deploy key for the correct env    |
| `Cannot find module 'convex'`         | Dependency not installed              | Check `pnpm install` runs first           |
| TypeScript errors                     | Type errors in code                   | Run `npx tsc --noEmit` locally            |
| `Schema validation failed`            | Schema doesn't match existing data    | See [Schema Safety](#14-convex-schema-safety--migrations) |
| `pnpm: not found`                     | Vercel not detecting pnpm             | Ensure `pnpm-lock.yaml` is committed      |
| Build timeout                         | Build takes > 45 min                  | Optimize build, check for loops           |

### Convex Connection Issues

| Symptom                               | Likely cause                          | Fix                                       |
| ------------------------------------- | ------------------------------------- | ----------------------------------------- |
| "Cannot connect to Convex"            | Wrong `CONVEX_URL`                    | Verify env var matches deployment          |
| Real-time updates not working         | WebSocket blocked                     | Check firewall / proxy settings            |
| Auth token invalid                    | WorkOS config mismatch                | Verify `WORKOS_CLIENT_ID` in Convex env    |
| Functions return undefined            | Deployment mismatch                   | Ensure Convex functions deployed to correct env |

### WorkOS Auth Issues

| Symptom                               | Likely cause                          | Fix                                       |
| ------------------------------------- | ------------------------------------- | ----------------------------------------- |
| Redirect after login fails            | `convex.json` `configure` block wrong | Verify `${buildEnv.VERCEL_PROJECT_PRODUCTION_URL}` resolves correctly; check Vercel build logs for WorkOS config output |
| "Invalid client" error                | Wrong `WORKOS_CLIENT_ID`              | Ensure Vercel env var matches the AuthKit env created in Convex dashboard |
| Cookie not set                        | `WORKOS_COOKIE_PASSWORD` missing/short | Must be ≥ 32 characters; set in Vercel env vars |
| Auth works locally but not on Vercel  | Using `sk_test_` in production        | Check Vercel Production scope has `sk_live_` key from prod AuthKit env |
| "WORKOS_API_KEY not found" in build   | Missing in Vercel env vars            | Copy from Convex dashboard AuthKit integration; must be available at build time |

### Calendly OAuth Issues

| Symptom                               | Likely cause                          | Fix                                       |
| ------------------------------------- | ------------------------------------- | ----------------------------------------- |
| OAuth redirect fails                  | Callback URL not registered           | Add production URL in Calendly dev portal  |
| Token refresh fails                   | Secret mismatch                       | Verify `CALENDLY_CLIENT_SECRET` in Convex  |
| Webhooks not received                 | Wrong webhook URL                     | Verify pointing to production Convex site URL |

---

## 20. Maintenance Schedule

### Weekly

- [ ] Review Vercel deployment logs for errors
- [ ] Check Convex function logs for failures
- [ ] Monitor database growth (Convex dashboard)
- [ ] Review any failed webhook events (`rawWebhookEvents` table)

### Monthly

- [ ] Run `pnpm audit` for security vulnerabilities
- [ ] Review Convex insights for performance regressions
- [ ] Check Vercel Web Vitals trends
- [ ] Update non-breaking dependencies

### Quarterly

- [ ] Rotate all API keys (WorkOS, Calendly)
- [ ] Update `WORKOS_COOKIE_PASSWORD`
- [ ] Major dependency updates (Next.js, Convex, React)
- [ ] Review and update this deployment guide
- [ ] Performance audit (Core Web Vitals, Convex query times)
- [ ] Security review (access controls, exposed secrets)

---

## 21. Pre-Deployment Checklist

Use this checklist before the very first production deployment:

### Code Changes ✅
- [ ] `convex.json` updated with `preview` and `prod` sections (Step 1)
- [ ] Changes committed and pushed

### GitHub ✅
- [ ] Repository created and code pushed (Step 0)
- [ ] `main` and `dev` branches exist
- [ ] Branch protection rules configured
- [ ] `.gitignore` includes all sensitive files
- [ ] Auto-delete merged branches enabled

### Convex ✅
- [ ] Production deployment exists in dashboard
- [ ] **Production AuthKit environment** created via Convex dashboard (provides `WORKOS_CLIENT_ID` + `sk_live_` key + `WORKOS_ENVIRONMENT_ID`)
- [ ] **Preview AuthKit environment** created via Convex dashboard (project-level, provides `sk_test_` key)
- [ ] Production deploy key generated
- [ ] Preview deploy key generated
- [ ] **All 10 production env vars set** (run `npx convex env list` to verify):
  - [ ] `WORKOS_CLIENT_ID` — auto from AuthKit
  - [ ] `WORKOS_API_KEY` — auto from AuthKit
  - [ ] `WORKOS_ENVIRONMENT_ID` — auto from AuthKit
  - [ ] `WORKOS_WEBHOOK_SECRET` — manual ⛔ **BLOCKED: requires production environment setup**
  - [ ] `CALENDLY_CLIENT_ID` — manual
  - [ ] `CALENDLY_CLIENT_SECRET` — manual
  - [ ] `CALENDLY_WEBHOOK_SIGNING_KEY` — manual
  - [ ] `INVITE_SIGNING_SECRET` — manual
  - [ ] `NEXT_PUBLIC_APP_URL` — manual (`https://yourdomain.com`) ⛔ **BLOCKED: no domain yet**
  - [ ] `SYSTEM_ADMIN_ORG_ID` — manual (WorkOS org ID for the system admin organization)
- [ ] Schema is stable and matches any existing dev data patterns
- [ ] `npx convex insights` reviewed — no critical issues

### Vercel ✅
- [ ] Project created and linked to GitHub repo
- [ ] Build command set: `npx convex deploy --cmd 'pnpm build'`
- [ ] Production branch set to `main`
- [ ] **Production-scoped env vars:**
  - [ ] `CONVEX_DEPLOY_KEY` (prod key)
  - [ ] `WORKOS_CLIENT_ID` (from prod AuthKit env)
  - [ ] `WORKOS_API_KEY` (`sk_live_...` from prod AuthKit env)
  - [ ] `WORKOS_COOKIE_PASSWORD` (≥32 chars)
  - [ ] `NEXT_PUBLIC_WORKOS_REDIRECT_URI` (`https://yourdomain.com/callback`) ⛔ **BLOCKED: no domain yet**
  - [ ] `NEXT_PUBLIC_CALENDLY_CLIENT_ID`
  - [ ] `CALENDLY_CLIENT_SECRET`
  - [ ] `NEXT_PUBLIC_APP_URL` (`https://yourdomain.com`) ⛔ **BLOCKED: no domain yet**
- [ ] **Preview-scoped env vars:**
  - [ ] `CONVEX_DEPLOY_KEY` (preview key)
  - [ ] `WORKOS_CLIENT_ID` (from preview AuthKit env)
  - [ ] `WORKOS_API_KEY` (`sk_test_...` from preview AuthKit env)
  - [ ] `WORKOS_COOKIE_PASSWORD` (≥32 chars, different from prod)
  - [ ] `NEXT_PUBLIC_WORKOS_REDIRECT_URI` (may need branch-specific handling)
  - [ ] `NEXT_PUBLIC_CALENDLY_CLIENT_ID`
  - [ ] `CALENDLY_CLIENT_SECRET`
  - [ ] `NEXT_PUBLIC_APP_URL`
- [ ] Custom domain configured (if ready)

### WorkOS (Convex-Managed) ✅
- [ ] AuthKit environments created via **Convex dashboard** (NOT WorkOS dashboard)
- [ ] Redirect URIs configured via `convex.json` `configure` blocks (automatic at deploy time)
- [ ] Credentials copied from Convex dashboard to Vercel env vars
- [ ] `WORKOS_COOKIE_PASSWORD` generated and set

### Calendly ✅
- [ ] Production OAuth redirect URI registered in Calendly developer portal
- [ ] Production webhook URL points to Convex production `CONVEX_SITE_URL`
- [ ] Client ID and secret set in both Vercel and Convex

### Testing ✅
- [ ] `pnpm build` succeeds locally
- [ ] `npx tsc --noEmit` passes
- [ ] `pnpm lint` passes
- [ ] Full auth flow tested on a preview deployment first
- [ ] Calendly OAuth flow tested on a preview deployment
- [ ] Critical user journeys tested end-to-end

---

## 22. FAQ

**Q: Do I need to run `npx convex deploy` separately from the Vercel build?**
A: No. The Vercel build command `npx convex deploy --cmd 'pnpm build'` handles both Convex and Next.js deployment atomically.

**Q: What happens to Convex preview deployments when I delete a branch?**
A: Preview deployments are associated with the branch name. They remain in your project but are inactive. They don't consume resources when not in use.

**Q: Can I use the same WorkOS credentials for dev and prod?**
A: No. Each Convex deployment (dev, preview, prod) gets its own AuthKit environment with its own `WORKOS_CLIENT_ID` and `WORKOS_API_KEY`. Production uses `sk_live_` keys, development uses `sk_test_`. These are created through the Convex dashboard, not WorkOS directly.

**Q: Do I need to go to the WorkOS dashboard to configure redirect URIs?**
A: No. This project uses a Convex-managed WorkOS team. The `configure` blocks in `convex.json` tell Convex what to set in WorkOS at deploy time. Redirect URIs, CORS origins, and homepage URLs are all configured automatically using Vercel's build environment variables (`VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL_BRANCH_URL`).

**Q: What if I need to seed data in a preview deployment?**
A: Use the `--preview-run` flag: `npx convex deploy --cmd 'pnpm build' --preview-run 'seedData'`. Create a Convex function called `seedData` that inserts test data.

**Q: How do I handle a schema migration in production?**
A: Use the Widen → Migrate → Narrow approach. Never make breaking schema changes directly. See [Schema Safety](#15-convex-schema-safety--migrations).

**Q: Can team members deploy directly to production?**
A: Only via merging to `main` on GitHub, which triggers the Vercel auto-deploy. No one should run `npx convex deploy` against production manually in normal operations.

**Q: What's the difference between Vercel preview and a staging environment?**
A: Preview deployments are per-PR with isolated Convex backends (empty data). A "staging" environment would be the `dev` branch — a persistent preview deployment with the `dev` branch's Convex preview backend. You can assign a custom domain to the `dev` branch (e.g., `staging.yourdomain.com`) in Vercel for a persistent staging URL.

**Q: Do I need a `vercel.json` file?**
A: Not required — the build command and env vars can all be configured in the Vercel dashboard. However, a `vercel.json` is useful for security headers and region configuration. Add it when ready.

**Q: How do I check which Convex deployment a Vercel build used?**
A: Check the Vercel build logs — `npx convex deploy` outputs the deployment URL it targeted.

---

## 23. Resources

| Resource                                                                 | Description                             |
| ------------------------------------------------------------------------ | --------------------------------------- |
| [Convex Production Docs](https://docs.convex.dev/production)             | Official production deployment guide    |
| [Convex + Vercel Hosting](https://docs.convex.dev/production/hosting/vercel) | Vercel-specific Convex integration  |
| [Convex AuthKit Setup](https://docs.convex.dev/auth/authkit)             | Convex-managed WorkOS AuthKit guide     |
| [Convex AuthKit Auto-Provision](https://docs.convex.dev/auth/authkit/auto-provision) | How auto-config works (`convex.json`) |
| [Convex AuthKit Add to App](https://docs.convex.dev/auth/authkit/add-to-app) | Adding AuthKit to existing Convex app |
| [Convex Environment Variables](https://docs.convex.dev/production/environment-variables) | Backend env var management |
| [Convex Best Practices](https://docs.convex.dev/production/best-practices) | Security, performance, code quality  |
| [Vercel Git Integration](https://vercel.com/docs/git)                    | Branch-based deployments                |
| [Vercel Environment Variables](https://vercel.com/docs/projects/environment-variables) | Scoped env var management |
| [WorkOS AuthKit Docs](https://workos.com/docs/user-management/nextjs)    | Next.js integration guide               |
| [Calendly API v2 Docs](https://developer.calendly.com/api-docs)         | OAuth and webhook reference             |

---

## Document History

| Version | Date       | Changes                                                  |
| ------- | ---------- | -------------------------------------------------------- |
| 1.0.0   | 2026-04-04 | Initial production deployment guide                      |
| 1.1.0   | 2026-04-04 | Corrected for Convex-managed WorkOS model; added `convex.json` `preview`/`prod` sections; fixed env var matrix |
