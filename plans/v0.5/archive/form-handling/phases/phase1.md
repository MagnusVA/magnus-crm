# Phase 1 — Infrastructure Setup

**Goal:** Install React Hook Form, Zod, and the @hookform/resolvers package. Add the shadcn `<Form>` component and configure tree-shaking in next.config.ts. After this phase, the codebase has all dependencies and components needed for form migrations in subsequent phases, with zero functional changes to existing forms.

**Prerequisite:** None — this is the foundational phase with no dependencies on prior work.

**Runs in PARALLEL with:** Nothing — all subsequent phases depend on the packages and components created here.

**Skills to invoke:**
- `shadcn` — Adding the form component via CLI, ensuring it integrates with the `radix-nova` style preset
- `next-best-practices` — Confirming new packages don't break SSR and tree-shaking is configured correctly

**Acceptance Criteria:**
1. `react-hook-form`, `@hookform/resolvers`, and `zod` are installed and listed in `package.json`.
2. `components/ui/form.tsx` exists and exports `Form`, `FormField`, `FormItem`, `FormLabel`, `FormControl`, `FormMessage`, `FormDescription`.
3. All exports from `components/ui/form.tsx` match the shadcn/ui `form` component (built on Radix + Next.js App Router).
4. `next.config.ts` includes `"zod"` in the `optimizePackageImports` array alongside `lucide-react`, `date-fns`, `recharts`.
5. `pnpm install` completes without errors and dependency tree is clean.
6. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
1A (Install packages) ──┐
                        ├── 1B (Add shadcn form) ──→ 1C (Update next.config.ts)
```

**Optimal execution:**
1. Start 1A — install all npm packages
2. Once 1A completes → start 1B — add the shadcn form component
3. Once 1B completes → start 1C — update next.config.ts for tree-shaking
4. Verify all acceptance criteria

**Estimated time:** 10–15 minutes

---

## Subphases

### 1A — Install React Hook Form, Zod, and Resolver

**Type:** Backend / Config
**Parallelizable:** No — must complete first. All subsequent subphases depend on these packages being installed.

**What:** Install three npm packages: `react-hook-form`, `@hookform/resolvers`, and `zod` via pnpm.

**Why:** React Hook Form is the form state management library. Zod is the schema validation library. The resolver bridges them. Without these, no form migrations can proceed.

**Where:**
- `package.json` (modify)
- `pnpm-lock.yaml` (auto-updated by pnpm)

**How:**

**Step 1: Install the packages**

```bash
# Path: project root
pnpm add react-hook-form @hookform/resolvers zod
```

**Step 2: Verify installation**

```bash
# Path: project root
# Check that all three appear in package.json
cat package.json | grep -E "(react-hook-form|@hookform/resolvers|zod)"

# Verify pnpm-lock.yaml was updated
ls -la pnpm-lock.yaml
```

Expected output in `package.json`:
```json
{
  "dependencies": {
    "react-hook-form": "^7.x.x",
    "@hookform/resolvers": "^3.x.x",
    "zod": "^3.x.x"
  }
}
```

**Step 3: Install all dependencies**

```bash
# Path: project root
pnpm install
```

Verify no errors. The output should show all packages resolved and node_modules updated.

**Key implementation notes:**
- All three packages are client-side only (never imported in Convex functions or server-only files).
- React Hook Form ships with tree-shaking enabled by default.
- Zod has multiple sub-modules; we'll optimize this in 1C.
- `@hookform/resolvers` is a small package that just bridges RHF and validation libraries (Zod, Yup, etc.). It has no side effects.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `package.json` | Modify | Add three dependencies |
| `pnpm-lock.yaml` | Modify | Auto-updated by pnpm |

---

### 1B — Add shadcn Form Component

**Type:** Frontend / Config
**Parallelizable:** No — depends on 1A (packages must be installed). Must complete before 1C.

**What:** Use the shadcn CLI to generate the `form` component, which exports `Form`, `FormField`, `FormItem`, `FormLabel`, `FormControl`, `FormMessage`, and `FormDescription` — all built on Radix UI primitives and tightly integrated with React Hook Form.

**Why:** The shadcn `form` component wraps RHF's `FormProvider` and `Controller` with styled Radix UI primitives. Without this, we'd have to manually wire RHF's internal APIs, which is error-prone and verbose.

**Where:**
- `components/ui/form.tsx` (create)

**How:**

**Step 1: Run the shadcn CLI**

```bash
# Path: project root
npx shadcn@latest add form
```

When prompted:
- **Confirm installation to `components/ui/`?** → Yes
- **Use TypeScript?** → Yes (already using TS)
- **Style preset?** — Should auto-detect `radix-nova` from your `components.json`; confirm it matches

**Step 2: Verify the generated file**

```bash
# Path: project root
ls -la components/ui/form.tsx
```

The file should exist and be ~200 lines. It exports:

```typescript
export { Form, FormField, FormItem, FormLabel, FormControl, FormMessage, FormDescription };
```

**Step 3: Check types**

```bash
# Path: project root
pnpm tsc --noEmit
```

No type errors should appear related to the new form component. If there are, it usually means `react-hook-form` wasn't installed correctly (go back to 1A).

**Key implementation notes:**
- The `Form` component is a simple wrapper around RHF's `FormProvider`. It does not render any DOM.
- `FormField` wraps RHF's `Controller` — it manages the connection between a named field and the input element.
- `FormMessage` is the key new component — it reads `fieldState.error` from RHF's `Controller` and renders the error message inline.
- The generated component uses the style preset specified in `components.json` (should be `radix-nova`).
- This component coexists with the existing `Field` compound components in `components/ui/field.tsx` — no breaking changes.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `components/ui/form.tsx` | Create | Generated by shadcn CLI |

---

### 1C — Update next.config.ts for Tree-Shaking

**Type:** Config
**Parallelizable:** No — depends on 1A (packages must be installed) and 1B (form component must exist).

**What:** Add `"zod"` to the `optimizePackageImports` array in `next.config.ts` to ensure Zod's multiple sub-modules are properly tree-shaken during the Next.js build.

**Why:** Zod exports many internal modules (`zod/lib`, `zod/types`, etc.). Without explicit tree-shaking configuration, the bundler may include unused Zod code, bloating the client bundle. The `optimizePackageImports` setting tells Next.js to intelligently import only what's needed.

**Where:**
- `next.config.ts` (modify)

**How:**

**Step 1: Locate the optimizePackageImports array**

Open `next.config.ts` and find the `optimizePackageImports` array. It should already contain `lucide-react`, `date-fns`, `recharts`:

```typescript
// Path: next.config.ts
const nextConfig = {
  // ... other config
  experimental: {
    optimizePackageImports: ["lucide-react", "date-fns", "recharts"],
  },
};
```

**Step 2: Add "zod" to the array**

```typescript
// Path: next.config.ts

const nextConfig = {
  // ... other config
  experimental: {
    optimizePackageImports: ["lucide-react", "date-fns", "recharts", "zod"],
  },
};
```

**Step 3: Verify the change**

```bash
# Path: project root
pnpm tsc --noEmit
```

No errors. The `next.config.ts` should parse and type-check correctly.

**Step 4: Build and verify bundle size (optional)**

```bash
# Path: project root
pnpm build
```

Check the build output for any warnings. Bundle size should be reasonable (the Zod addition is typically <50 KB, and tree-shaking should reduce this further).

**Key implementation notes:**
- `optimizePackageImports` is an experimental Next.js feature that uses the `sideEffects` field in package.json to guide tree-shaking.
- Zod has zero side effects, so tree-shaking is safe and effective.
- This change is transparent to application code — no imports or usage changes required.
- The feature must be in the `experimental` section of the config (as of Next.js 16).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `next.config.ts` | Modify | Add `"zod"` to `optimizePackageImports` array |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `package.json` | Modify | 1A |
| `pnpm-lock.yaml` | Modify | 1A |
| `components/ui/form.tsx` | Create | 1B |
| `next.config.ts` | Modify | 1C |

---

## Implementation Notes

### Coexistence with Existing Field Components

The new `<Form>`, `<FormField>`, `<FormItem>`, `<FormLabel>`, `<FormControl>`, `<FormMessage>` from `components/ui/form.tsx` coexist peacefully with the existing `<Field>`, `<FieldGroup>`, `<FieldLabel>`, `<FieldDescription>`, `<FieldError>` from `components/ui/field.tsx`:

- **Inside forms** (dialogs): Use shadcn `Form*` components (they require RHF context).
- **Outside forms** (read-only displays, filter groups, settings panels): Use existing `Field*` components (lightweight, no dependencies).

No refactoring of existing code is needed.

### Verification Commands

After completing all subphases, run these verification commands:

```bash
# Verify packages are installed
pnpm list react-hook-form @hookform/resolvers zod

# Verify no TypeScript errors
pnpm tsc --noEmit

# (Optional) Verify the build
pnpm build

# (Optional) Verify the form component is importable
pnpm exec tsx -e "import { Form } from '@/components/ui/form'; console.log('✓ Form imported successfully');"
```

All commands should complete without errors.

---

## Next Phase

Once Phase 1 is complete, proceed to **Phase 2: Payment Form Dialog Migration**. The Payment Form is the most complex dialog (8 useState hooks, file upload, multi-step Convex flow), so migrating it first proves the pattern works for the hardest case.
