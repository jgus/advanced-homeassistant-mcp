# Project notes for Claude

## Environment

A Nix flake provides the dev shell. With direnv installed, `cd` into the repo and the shell is loaded automatically (it includes `bun`, `nodejs`, `ffmpeg`, `killall`, plus standard tooling). Without direnv, `nix develop` gives you the same environment.

If neither is available, invoke bun directly via Nix:

```sh
nix run "nixpkgs#bun" -- <args>
```

The `nixpkgs#bun` spec is quoted so the `#` doesn't get interpreted by the shell or the Claude permission framework.

## Running things

```sh
bun install
bun test --preload ./test/setup.ts          # full suite
bun test --preload ./test/setup.ts <file>   # single file
bun run lint                                 # eslint
bun x tsc --noEmit                           # type check (slow)
bun run build                                # esbuild bundle
```

The `--preload ./test/setup.ts` is **required** for `bun test`. The preload sets `HASS_TOKEN`, `JWT_SECRET`, etc. at module-load time so modules that read env vars during top-level construction get the test values. Forgetting it causes confusing failures in modules that hit a missing-env guard before the `beforeAll` hook can run.

`nix run '.#lint'` and `nix run '.#test'` are thin wrappers around the bun commands above — useful when you want to run them without entering the dev shell. Both expect `bun install` to have been run already in the workspace.

## Test conventions

- Tests live under `__tests__/` (project tests) and `src/**/__tests__/` (colocated with their target module). Both directories run under the same `bun test` invocation.
- `test/e2e/automation.test.ts` is gated behind `RUN_E2E=true` AND a built `dist/stdio-server.mjs`. The default `bun test` skips it.
- Use `bun:test` exclusively. **Don't** import `jest`, `@jest/globals`, or `jest-mock` — they're not installed and the references are dead.
- `mock.module()` is hoisted by bun to the top of the file. Place it before static imports of the module being mocked. Its return type is `void | Promise<void>`; if you call it without awaiting, prefix `void` to silence `@typescript-eslint/no-floating-promises`.

## Things that bit me — read before editing

### bun-types has wrong types for `expect(promise).resolves/rejects`

Upstream `bun-types` declares the matcher chain as synchronous (returns `Matchers<T>`), but the runtime returns `Promise<void>` per Jest convention. Plain `await expect(p).rejects.toThrow(msg)` works at runtime but trips `@typescript-eslint/await-thenable` at lint time.

Fixed once at `__tests__/types/bun-test-augment.d.ts` via declaration merging — every method on `resolves`/`rejects` is retyped to return `Promise<void>`. Don't go suppressing await-thenable in individual test files; the augment handles all of them.

### Don't shadow third-party module types in `src/types/`

A historical `src/types/bun.d.ts` re-declared `bun:test` with a stale, wrong shape (`mock.calls` typed as `Array<{args, returned}>` instead of the real `Array<Parameters<T>>`). It silently shadowed the real `bun-types` types and made dozens of test files emit fake type errors. That file is gone. If you find yourself wanting to write `declare module "some-package"` in `src/types/`, you almost certainly want a tiny declaration merge in a co-located `.d.ts` next to the caller, not a wholesale shadow of the package.

### Module mocks and globals leak across files in one bun process

`mock.module(path, factory)` persists for the lifetime of the bun process — so a test file that mocks `src/hass/index.js` leaks that mock into every later test that imports the module. Same with direct mutations like `TokenManager.validateToken = mock(...)`.

Patterns that survive:

- For module-level static-method overrides, capture the original `.bind(target)` once at module scope and restore in `afterEach`:
  ```ts
  const original = TokenManager.validateToken.bind(TokenManager);
  beforeEach(() => { TokenManager.validateToken = mockFn; });
  afterEach(() => { TokenManager.validateToken = original; });
  ```
  The `.bind(target)` is load-bearing — without it the static method's `this`-using helpers (`recordFailedAttempt`, `isRateLimited`) break after restoration. It also keeps eslint's `no-unbound-method` rule quiet.
- For `mock.module(...)` of a module that other tests import, prefer testing the real module against `global.fetch` mocks instead. Module mocks have no clean teardown.

### The HomeAssistantAPI singleton + 30-second cache leaks state

`get_hass()` returns a process-singleton with a 30-second `states` cache. Any test that exercises `getStates()` will see the cached response from a previous test. Call `hass.clearCache()` in `beforeEach` for tool tests; the method exists specifically as a test hook.

### Don't put side effects at module top level if the module gets imported

`src/index.ts` wraps `main()` in `if (import.meta.main) { ... }` for this exact reason. Any module that auto-runs and `process.exit`s on failure will silently kill bun's test runner with exit code 0 — the suite reports "no tests ran" and the actual failure is invisible.

### Tool execute responses use `{ success: boolean, ... }`

All tool `execute` functions should return (or `JSON.stringify`) an object with `success: true` on the happy path and `success: false` + `message` on error. The test suite asserts on `parsed.success`. Inconsistent shapes (`{ status: "success" }`, raw `{ devices }`) make otherwise correct tests fail.

### supertest GET + body hangs

`supertest.get(path).send(body)` will hang the request indefinitely in current node + supertest combos, regardless of what the server does. If you need to send a body, use POST. If the handler tolerates a missing body (e.g. uses `req.body ?? {}`), just drop the `.send()`.

### `await mock.module(...)` won't compile

Top-level `await` requires `module: esnext`-ish in tsconfig. This repo is on `module: CommonJS` for build reasons. Use `void mock.module(...)` instead — same runtime behavior, no top-level await needed.

### `\x1b` in `error-log.tool.ts` is intentional

The `stripAnsi()` regex matches the ESC byte to remove ANSI color sequences from Supervisor logs. eslint's `no-control-regex` flags literal control chars in regexes because they're usually typos — this one isn't. The suppression carries an inline justification.

### `require()` in `smithery-{entry,minimal}.ts` is intentional

The MCP SDK is CJS-only and these entry points dynamically `require()` it at runtime so esbuild doesn't pull the SDK in statically. Don't rewrite to `import` — you'll bloat the bundle and break the Smithery deployment shape.

## Code style

- No `async` on functions that don't `await`. If the function must return a Promise to satisfy an interface or for symmetry with an async future, `return Promise.resolve(value)` instead.
- No `as any` casts in source. Type the data at its source instead (e.g. `JSON.parse(s) as MyShape`, narrow `req.body` once at the top of the handler).
- For exhaustive `switch` over a string-literal union, the `default` case will narrow the discriminant to `never`. Use `String(value)` in the error message so the template literal compiles.
- Tool error paths: `error instanceof Error ? error.message : String(error)` — the rest of the codebase already uses this idiom.

## Lint and type pre-flight

The pre-existing repo had ~100 lint errors that have since been fixed. Don't reintroduce them. Before committing:

```sh
bun run lint                       # must report 0 errors
bun test --preload ./test/setup.ts # must report 0 fail
```

Or `nix run '.#lint'` / `nix run '.#test'` if you don't want to enter the dev shell.

Warnings are tolerated (the project's eslint config rates many strict rules as `warn` rather than `error`), but new errors block CI.
