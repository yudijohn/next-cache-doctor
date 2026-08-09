# next-cache-doctor

Static analysis CLI for Next.js's `'use cache'` directive (Next.js 15.2+ / 16 Cache Components).

Next.js 16 flipped caching from implicit to explicit: nothing is cached unless you opt in with `'use cache'`. That's great for control, but two mistakes are easy to make and easy to miss in review:

1. Forgetting `cacheLife(...)`, so the cache duration silently falls back to a default profile instead of being explicit at the call site.
2. Calling `cookies()`, `headers()`, or reading `searchParams` **inside** a plain `'use cache'` scope — which can serve one user's cached data to a different user, because the cache key doesn't account for the request.

`next-cache-doctor` scans your codebase and flags both, before they ship.

```
npx next-cache-doctor scan .
```

```
next-cache-doctor v0.1.0
Scanned 42 file(s), 6 contain a 'use cache' scope.

app/dashboard/page.tsx
   ERROR  L18  [possible-private-data-leak]
         "getUserDashboard" is cached with plain 'use cache' but calls cookies() inside
         the cached scope. This can leak per-user data across users. Use
         'use cache: private', or refactor to pass the value in as an argument instead.

app/products/actions.ts
   WARN   L4  [missing-cache-life]
         'use cache' scope "getProducts" has no explicit cacheLife(...). The default
         profile will apply implicitly - add cacheLife() to make the duration explicit
         at the call site.

1 error(s), 1 warning(s) across 2 file(s).
```

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
next-cache-doctor scan [path]        # defaults to current directory
next-cache-doctor scan . --json      # machine-readable output for CI/tooling
next-cache-doctor scan . --fail-on warning   # also exit non-zero on warnings (default: error)
```

Exit code is `1` if any error-level finding exists (or warning-level too, with `--fail-on warning`), so it works as a CI gate:

```yaml
# .github/workflows/ci.yml
- run: npx next-cache-doctor scan .
```

## Rules

| Rule | Severity | What it catches |
|---|---|---|
| `missing-cache-life` | warning | A `'use cache'` scope with no `cacheLife(...)` call, so the duration is left implicit. |
| `possible-private-data-leak` | error | A plain `'use cache'` scope (not `'use cache: private'`) that calls `cookies()`, `headers()`, or reads `searchParams`. |

## How it works

`next-cache-doctor` parses each `.ts`/`.tsx` file with the TypeScript compiler API, finds functions/components/files whose body opens with a `'use cache'` directive prologue, and inspects each scope for the signals above. It does not execute your code and does not require your project to build.

## Known limitations (v0.1)

- Detection is name-based: it looks for calls to identifiers literally named `cacheLife`, `cacheTag`, `cookies`, `headers`. Re-exporting these under a different name will not be detected.
- Nested nested cache scopes are handled (an inner `'use cache'` function is treated as its own independent scope), but non-directive helper functions called from within a cache scope are not currently traced — the leak rule only looks at calls made directly inside the cached function body.
- No auto-fix yet. Findings are reported only.

Contributions and bug reports are very welcome — this is an early v0.1 focused on the two highest-signal rules first.

## Roadmap

- `missing-cache-tag` rule (informational) for scopes that would benefit from on-demand invalidation
- `--fix` for the trivial cases (e.g. inserting a `cacheLife('hours')` stub)
- VS Code extension / inline devtools overlay showing cache boundaries at dev time
- Trace helper-function calls, not just direct calls, for the leak rule

## License

MIT
