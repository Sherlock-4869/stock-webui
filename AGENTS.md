# Repository Guidelines

## Project overview

This repository is a Node.js 18+ stock-monitoring web application. It uses the
built-in HTTP server rather than a web framework. The browser application is
mostly contained in `public/index.html`; keep changes there focused and avoid
introducing a build step unless the task explicitly calls for one.

The optional account and WeChat modules use MySQL through `mysql2`. The chat
module is currently process-local. Features controlled by environment variables
must continue to degrade gracefully when disabled.

## Important paths

- `server.js`: HTTP entry point, static files, stock API proxying, and module routing.
- `public/index.html`: main application markup, styles, and browser-side logic.
- `account/`: account configuration, authentication, persistence, and API routes.
- `chat/`: chat service and SSE endpoints.
- `wechat/`: official-account callbacks, API client, scheduling, and notifications.
- `database/`: canonical SQL schema files used by operators.
- `test/`: Node test-runner suites.
- `.env.example`: documented configuration keys; never put real credentials here.
- `README.md`: setup, deployment, environment, and database documentation.

## Local commands

Use the repository scripts instead of adding one-off command variants:

```sh
npm install
npm run check
npm test
npm start
```

For the deployment-style wrapper, use `./run.sh install`, `./run.sh verify`,
`./run.sh start`, `./run.sh restart`, or `./run.sh check` as appropriate.

Before handing off a code change, run at least `npm run check` and `npm test`.
If a check cannot run because an external service is unavailable, report that
explicitly and still run all unaffected checks.

## Change discipline

- Preserve unrelated working-tree changes. Do not reformat the large single-file
  frontend or perform broad mechanical rewrites unless requested.
- Prefer small modules with CommonJS exports, matching the existing codebase.
- Keep the application compatible with Node.js 18 and browser-native APIs.
- Add or update tests for behavior changes, especially authentication, ownership,
  request validation, schema adapters, and date/time logic.
- Update `.env.example` and `README.md` whenever a configuration key or deployment
  step is added or changed.

## API and security rules

- Treat all browser-supplied identity fields as untrusted. Derive authenticated
  user IDs, names, avatars, and permissions from the server-side session.
- Scope every account-owned read, update, and delete by `user_id`; knowing a row
  ID must never grant access to another account's data.
- Apply same-origin/CSRF checks to state-changing browser routes and set explicit
  request-body limits. Public endpoints also need abuse controls such as rate and
  connection limits.
- Do not log passwords, session tokens, OAuth secrets, OpenIDs, or full sensitive
  request bodies. Keep session cookies `HttpOnly`, `SameSite`, and `Secure` in HTTPS.
- Never render user-authored Markdown or imported document content via
  `innerHTML` without an allowlist sanitizer. Escape text and validate URL schemes.
- SSE and other long-lived connections must have bounded resource usage,
  idempotent cleanup, and correct disconnect handling.

## Database changes

When persistence changes, keep all three layers synchronized:

1. Runtime schema initialization and data-access methods in the relevant module.
2. The canonical SQL file under `database/`.
3. The complete operator-facing SQL and explanation in `README.md`.

Use additive, idempotent `CREATE TABLE IF NOT EXISTS` changes where possible.
Do not assume production database users have schema-change privileges; document
manual migration steps. Foreign keys for account-owned records should normally
use `ON DELETE CASCADE`.

## Frontend conventions

- Reuse the existing CSS variables, responsive behavior, toast/dialog helpers,
  and authenticated `apiRequest` path.
- Keep local visitor configuration separate from account-synced configuration.
- Flush or cancel pending autosaves before changing the active document/account.
- Avoid duplicate global function names in `public/index.html`; declarations share
  one global scope.
- Make asynchronous failures visible to the user and preserve unsent/unsaved input
  when a request fails.

## Review expectations

For reviews, prioritize exploitable security issues, cross-account access, data
loss, deployment/schema drift, and missing regression tests. Cite concrete file
and line locations. Do not modify reviewed feature code unless the user also asks
for fixes.
