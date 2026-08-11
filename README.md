# next-cache-doctor

[![npm version](https://img.shields.io/npm/v/next-cache-doctor.svg)](https://www.npmjs.com/package/next-cache-doctor)
[![CI](https://github.com/yudijohn/next-cache-doctor/actions/workflows/ci.yml/badge.svg)](https://github.com/yudijohn/next-cache-doctor/actions/workflows/ci.yml)
[![npm downloads](https://img.shields.io/npm/dm/next-cache-doctor.svg)](https://www.npmjs.com/package/next-cache-doctor)
[![license](https://img.shields.io/npm/l/next-cache-doctor.svg)](https://github.com/yudijohn/next-cache-doctor/blob/main/LICENSE)

Static analysis CLI for Next.js's `'use cache'` directive (Next.js 15.2+ / 16 Cache Components).

Next.js 16 flipped caching from implicit to explicit: nothing is cached unless you opt in with `'use cache'`. That's great for control, but a few mistakes are easy to make and easy to miss in review:

1. Forgetting `cacheLife(...)`, so the cache duration silently falls back to a default profile instead of being explicit at the call site.
2. Calling `cookies()`, `headers()`, or reading `searchParams` **inside** a plain `'use cache'` scope — directly, *or indirectly through a helper function you call* — which can serve one user's cached data to a different user, because the cache key doesn't account for the request.
3. Forgetting `cacheTag(...)`, so the only way to invalidate the cache is waiting for it to expire — no on-demand `revalidateTag()`.

`next-cache-doctor` scans your codebase and flags all three, before they ship — and can auto-fix the easy case.

```
npx next-cache-doctor scan .
```

```
next-cache-doctor v0.1.0
Scanned 42 file(s), 6 contain a 'use cache' scope.

app/dashboard/page.tsx
   ERROR  L18  [possible-private-data-leak]
         "getUserDashboard" is cached with plain 'use cache' but calls getSession(),
         which internally calls cookies(). This can leak per-user data across users.
         Use 'use cache: private', or refactor to pass the value in as an argument
         instead.

app/products/actions.ts
   WARN   L4  [missing-cache-life]
         'use cache' scope "getProducts" has no explicit cacheLife(...). The default
         profile will apply implicitly - add cacheLife() to make the duration explicit
         at the call site.
   INFO   L4  [missing-cache-tag]
         'use cache' scope "getProducts" has no cacheTag(...). Without a tag you can
         only invalidate this cache by waiting for cacheLife to expire, not on-demand
         via revalidateTag().

1 error(s), 1 warning(s), 1 info across 2 file(s).
```

![demo](./demo.gif)

## Install

```
npm install --save-dev next-cache-doctor
```

Or run it without installing:

```
npx next-cache-doctor scan .
```

## Usage

```
next-cache-doctor scan [path]                # defaults to current directory
next-cache-doctor scan . --json              # machine-readable output for CI/tooling
next-cache-doctor scan . --fail-on warning   # also exit non-zero on warnings (default: error)
next-cache-doctor scan . --fix               # auto-insert cacheLife('minutes') where it's missing
```

Exit code is `1` if any error-level finding exists (or warning-level too, with `--fail-on warning`), so it works as a CI gate:

```yaml
# .github/workflows/ci.yml
- run: npx next-cache-doctor scan .
```

## Rules

| Rule | Severity | What it catches |
|---|---|---|
| `missing-cache-life` | warning | A `'use cache'` scope with no `cacheLife(...)` call, so the duration is left implicit. Auto-fixable with `--fix`. |
| `possible-private-data-leak` | error | A plain `'use cache'` scope (not `'use cache: private'`) that calls `cookies()`, `headers()`, or reads `searchParams` — directly, or through a helper function it calls, including helpers imported from another local file (relative imports or a `tsconfig.json` path alias like `@/*`). |
| `missing-cache-tag` | info | A `'use cache'` scope with no `cacheTag(...)`, so it can only be invalidated by waiting for expiry, not on-demand. Auto-fixable with `--fix`. |

## `--fix`

Currently auto-fixes:
- `missing-cache-life` — inserts a `cacheLife('minutes')` stub
- `missing-cache-tag` — inserts a `cacheTag(...)` call with a name suggested from the function/file name (e.g. `getUserDashboard` → `'get-user-dashboard'`)

Both are starting points, not final answers — always review the diff and pick the duration/tag name that actually fits your data and invalidation strategy:

```
npx next-cache-doctor scan . --fix
```

## How it works

`next-cache-doctor` parses each `.ts`/`.tsx` file with the TypeScript compiler API, finds functions/components/files whose body opens with a `'use cache'` directive prologue, and inspects each scope for the signals above. For the leak rule, it builds a project-wide map of every file's top-level functions, exports, and imports first (also reading `tsconfig.json`'s `compilerOptions.paths` if present, to resolve alias imports like `@/lib/auth`), then recursively checks whether a function you call from inside a cache scope itself touches `cookies()`/`headers()`/`searchParams` — following the call chain through same-file helpers and through helpers imported from other local files (relative imports or a configured path alias), with cycle protection for both same-file and cross-file recursion. It does not execute your code and does not require your project to build.

## Known limitations (v0.1)

- Detection is name-based: it looks for calls to identifiers literally named `cacheLife`, `cacheTag`, `cookies`, `headers`. Re-exporting these under a different name will not be detected.
- Cross-file helper tracing follows relative imports (`./`, `../`) and `tsconfig.json` path aliases with a simple `"prefix/*": ["target/*"]` shape (covers the standard Next.js `@/*` convention). More exotic alias patterns, `baseUrl`-only resolution without `paths`, and monorepo package references aren't handled yet.
- Only named exports are traced. Default exports and namespace imports (`import * as ns`) are not tracked yet.
- A helper function that itself opens its own `'use cache'`/`'use cache: private'` scope is treated as independently validated and is not traced into — which is correct, since it manages its own caching.
- `--fix` covers `missing-cache-life` and `missing-cache-tag`. Suggested tag names are a starting point (derived from the function/file name) - rename them to match your actual invalidation strategy.

Contributions and bug reports are very welcome.

## Roadmap

- Default-export and namespace-import (`import * as ns`) tracing for the leak rule
- VS Code extension / inline devtools overlay showing cache boundaries at dev time

## License

MIT
