# Villahermosa Dental Clinic Backend

The backend is the Express API for the Villahermosa Dental Clinic staff application. It provides custom JWT authentication, role-aware clinic operations, PostgreSQL persistence through Prisma, notifications and messaging support, and the health endpoint used to wake and monitor the free Render service.

## Contents

- [Production status](#production-status)
- [Feature status](#feature-status)
- [Technology stack](#technology-stack)
- [Architecture](#architecture)
- [API organization](#api-organization)
- [Authentication and authorization](#authentication-and-authorization)
- [Database and Prisma](#database-and-prisma)
- [Environment variables](#environment-variables)
- [Local development](#local-development)
- [Package and database scripts](#package-and-database-scripts)
- [Build and deployment](#build-and-deployment)
- [Health and startup behavior](#health-and-startup-behavior)
- [CORS](#cors)
- [Errors and logging](#errors-and-logging)
- [Security notes](#security-notes)
- [Troubleshooting](#troubleshooting)
- [Related documentation](#related-documentation)

## Production status

The active backend is a Node.js service deployed to Render. Production data is stored in PostgreSQL; the current deployment is designed to work with a hosted PostgreSQL provider such as the configured Supabase database. Render runs Prisma migrations before starting the compiled server.

Public Booking, Patient Portal, and Staff Payroll are **Disabled modules**. In this documentation, _disabled_ means intentionally blocked from the active workflow while related code remains in the repository. Some legacy route handlers and Prisma models for these modules are still present and, in several cases, still registered by the server. Their presence does not make the modules supported or available.

## Feature status

| Module | Status | Availability | Backend responsibility |
| --- | --- | --- | --- |
| Staff authentication | Active | Admin, doctor, receptionist | Login, logout, token verification, staff registration, and password changes |
| Appointment management | Active | Authenticated staff | Scheduling, requests, availability, statuses, payments, and appointment logs |
| Patient records | Active | Authorized staff | Patient and dependent records, profiles, dental information, and history |
| Questionnaires | Active | Authorized staff | Patient answers and configurable questionnaire questions |
| Payments and payment methods | Active | Authenticated staff | Payment records, method configuration, and payment history |
| Finance and expenses | Active | Authenticated staff | Revenue, detailed expenses, inventory-related finance records, and audit snapshots |
| Inventory | Active | Authenticated staff | Inventory CRUD and inventory history |
| Staff directory | Active | Authenticated staff | Staff records and role data; compensation-related frontend workflows are disabled |
| Notifications | Active | Authenticated staff | Notification retrieval, unread counts, status updates, and deletion |
| Services and statuses | Active | Mixed read/write access | Appointment types and status configuration used by the staff UI |
| Public Booking | **Disabled** | Not available | Legacy public patient, availability, appointment, and doctor routes remain in code |
| Patient Portal | **Disabled** | Not available | Patient-auth and portal-related code remains, but the frontend portal is blocked |
| Staff Payroll | **Disabled** | Not available | Finance payroll handlers, routes, logs, and schema remain; the active frontend gates them off |

For each Disabled module: **this module still exists in the codebase but is currently disabled and is not part of the active production workflow.** Do not expose, document as active, or re-enable its API or UI without an explicit task and a review of authentication, permissions, database effects, and business rules. Do not delete existing module code unless explicitly requested.

## Technology stack

- Node.js 20 in Docker and Render-compatible Node hosting
- Express 5
- TypeScript with strict checking
- PostgreSQL
- Prisma 7 with `@prisma/adapter-pg` and `pg`
- JSON Web Tokens through `jsonwebtoken`
- Password hashing through `bcryptjs`
- CORS, dotenv, Nodemailer, and structured controller/route middleware

The project uses npm and includes `package-lock.json`.

## Architecture

### Important folders and files

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | Express setup, CORS, health routes, router mounting, startup synchronization, and server lifecycle |
| `src/routes/` | Route groups and route-level middleware |
| `src/controllers/` | Request validation and domain operations |
| `src/middleware/` | Authentication and role authorization middleware |
| `src/lib/prisma.ts` | PostgreSQL/Prisma client and SSL-aware connection setup |
| `src/services/` | Shared server-side services, including notification lifecycle behavior |
| `src/utils/` | JWT helpers, log/snapshot helpers, validation, date handling, and shared utilities |
| `src/seed/` | Prisma seed and delete utilities for development/reference data |
| `src/scripts/importJsonToPostgres.ts` | One-time import path for the legacy JSON dataset |
| `prisma/schema.prisma` | Current relational data model |
| `prisma/migrations/` | Versioned database migrations |
| `prisma.config.ts` | Prisma datasource configuration using `DIRECT_URL` or `DATABASE_URL` |
| `.env.example` | Safe environment-variable template |
| `render.yaml` | Render service build, start, health, and environment configuration |
| `Dockerfile` and `docker-entrypoint.sh` | Node 20 container build, database wait, migration, and startup |

The server initializes authentication data and notification lifecycle state before listening, then periodically synchronizes notification lifecycle behavior. Controllers use the shared Prisma client. Audit/history behavior is already centralized in utilities including appointment, payment, finance, expense, inventory, and payroll log helpers; extend those systems rather than introducing parallel history storage.

### Persistence model

The active runtime database is PostgreSQL, not in-memory storage and not JSON files. `prisma/schema.prisma` currently defines models for patients, appointments and appointment logs, payments and payment logs, payment methods, staff, staff financial records, staff attendance, notifications, finance records, detailed expenses, inventory, expense/inventory/payroll logs, questionnaires, and status configuration.

The root `villahermosa backend data/` directory is legacy source data for the JSON-to-PostgreSQL import script. It is not the production persistence layer.

## API organization

The following route groups are mounted by `src/index.ts`. This is an overview of verified responsibilities, not a complete endpoint contract.

| Base path | Responsibility |
| --- | --- |
| `/api/auth` | Login, logout, token verification, registration, and password changes |
| `/api/patients` | Patient/dependent records and legacy public-booking registration code |
| `/api/questionnaires` | Patient questionnaire responses |
| `/api/questionnaire-questions` | Configurable questionnaire questions |
| `/api/appointments` | Appointment CRUD, requests, availability, payments, logs, and legacy public booking |
| `/api/appointment-types` | Service/appointment-type configuration |
| `/api/finance` | Revenue, expenses, inventory finance operations, histories, and disabled payroll handlers |
| `/api/staff` | Staff management, attendance/financial records, and legacy public doctor lookup |
| `/api/inventory` | Inventory management and history |
| `/api/payments` | Payment records and payment logs |
| `/api/payment-methods` | Payment-method configuration |
| `/api/messages` | Outbound message submission through configured messaging support |
| `/api/notifications` | Notifications, unread counts, read state, and deletion |
| `/api/statuses` | Appointment and payment status configuration |
| `/health` | Render readiness probe; returns `204 No Content` |
| `/api/health` | Compatibility alias; also returns `204 No Content` |

Examples of verified legacy routes associated with the Disabled Public Booking module include `/api/appointments/public-book`, `/api/appointments/public-availability`, `/api/patients/public-booking`, and `/api/staff/public-doctors`. Do not interpret their registration as approval to consume or expose them. They require a deliberate security and business review before any possible reactivation.

Authentication middleware is not applied uniformly to every legacy route. Inspect the actual router and controller before changing or documenting an endpoint. Do not infer protection merely from the route group's purpose.

## Authentication and authorization

Authentication is implemented by this server; there is no external authentication provider.

- Passwords are compared with `bcryptjs`.
- Successful login signs a JWT containing the user identity and role.
- The token is returned in the JSON response and set as the `authToken` HTTP-only cookie.
- In production, the cookie uses `Secure` and `SameSite=None`; locally it uses a less restrictive same-site setting suitable for localhost.
- The frontend sends the bearer token and credentials when verifying or calling protected routes.
- `GET /api/auth/verify` validates the token and loads the current staff record.
- `requireAuth` rejects missing or invalid sessions; `requireRole(...)` provides explicit role checks on routes that use it.

The JWT currently expires after 24 hours. The codebase has **no refresh token, refresh-token store, or refresh endpoint**. Do not document or implement a refresh flow unless the authentication design is explicitly changed across both repositories.

The active management roles are `admin`, `doctor`, and `receptionist`. The schema and authentication code also recognize `patient`, but Patient Portal is disabled. Backend role enforcement varies by operation: some routers require authentication globally, some sensitive mutations add explicit staff-role checks, and some legacy handlers remain less restricted. Preserve existing checks and review route-level middleware whenever changing an operation.

Authentication verification distinguishes invalid credentials from infrastructure failures:

- Missing, malformed, expired, or revoked-user tokens return `401`.
- Database or server failures during verification return a temporary `503` response rather than falsely proving that the session is invalid.
- `403` means the authenticated caller lacks permission where role middleware is used; it is not equivalent to logout.

## Database and Prisma

### Connection behavior

`DATABASE_URL` is required at runtime. `src/lib/prisma.ts` creates a PostgreSQL pool and Prisma adapter. It honors connection-string SSL settings and `DATABASE_SSL_REJECT_UNAUTHORIZED`; hosted Supabase-style connections are handled as SSL connections.

Prisma CLI operations use `DIRECT_URL` when present and otherwise fall back to `DATABASE_URL`. This permits deployments to use a pooled runtime connection and a direct connection for schema operations when the provider recommends it.

### Migrations

For local schema development:

```bash
npm run prisma:generate
npm run prisma:migrate
```

`npm run prisma:migrate` runs `prisma migrate dev`, so it is intended for development. Production deployment uses `npx prisma migrate deploy` in `render.yaml` and the Docker entrypoint.

Other database tools:

```bash
npm run prisma:studio
npm run db:push
```

Use `db:push` deliberately; it updates the schema without creating the same migration history as `migrate dev`.

### Seeding and legacy import

The main seed command is:

```bash
npm run seed
```

The repository also contains targeted seed and delete scripts for patients, doctors, staff, inventory, appointments, finance, and payment methods. Run `npm run seed:list` to display available seed operations. Seeders connect directly through Prisma; the API server does not need to be running.

Delete scripts and `delete:all` mutate database data. Confirm the target database and obtain the appropriate approval before running them.

To import the legacy JSON dataset:

```bash
npm run db:import-json
```

The import script uses the root legacy data folder by default and supports `JSON_DATA_DIR` as a script-specific override. Treat it as a migration utility, not as part of normal server startup.

## Environment variables

Start from `.env.example` and use placeholders appropriate to your environment:

```dotenv
PORT=3001
NODE_ENV=development

FRONTEND_URL=http://localhost:3000
FRONTEND_URLS=http://localhost:3000,https://your-preview.vercel.app

DATABASE_URL=postgresql://USER:PASSWORD@HOST:PORT/DATABASE
DIRECT_URL=postgresql://USER:PASSWORD@HOST:PORT/DATABASE
DATABASE_SSL_REJECT_UNAUTHORIZED=true

JWT_SECRET=replace-with-a-long-random-secret

SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-smtp-user
SMTP_PASS=your-smtp-password
SMTP_FROM=Villahermosa Dental Clinic <no-reply@example.com>
```

### Variable reference

| Variable | Required | Purpose |
| --- | --- | --- |
| `PORT` | No | API port; defaults to 3001 in local/server configuration |
| `NODE_ENV` | Recommended | Selects production cookie/error behavior and environment-specific configuration |
| `FRONTEND_URL` | Production | Primary allowed frontend origin |
| `FRONTEND_URLS` | Optional | Comma-separated additional CORS origins, such as Vercel previews |
| `DATABASE_URL` | Yes | Runtime PostgreSQL connection |
| `DIRECT_URL` | Optional | Direct Prisma CLI/migration connection; falls back to `DATABASE_URL` |
| `DATABASE_SSL_REJECT_UNAUTHORIZED` | Optional | Controls PostgreSQL TLS certificate verification |
| `JWT_SECRET` | Yes | JWT signing and verification secret; must remain stable and private |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | For email delivery | SMTP configuration used by messaging code |
| `DATABASE_WAIT_TIMEOUT_MS` | Docker only, optional | Maximum database wait time used by `docker-entrypoint.sh` |
| `JSON_DATA_DIR` | Import only, optional | Overrides the legacy JSON import source directory |

`.env.example` also lists `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_PHONE_NUMBER`. No active server source currently reads those values, so they are not documented as required runtime configuration. Do not assume SMS delivery is configured solely because the placeholders exist.

Never commit `.env` or real credentials.

## Local development

### Prerequisites

- Node.js 20 or a compatible current Node.js release
- npm
- PostgreSQL reachable through `DATABASE_URL`

### Setup

```bash
npm install
npm run prisma:generate
npm run prisma:migrate
npm run dev
```

Copy `.env.example` to `.env` first and replace placeholders with local values. The API listens on `http://localhost:3001` by default. Verify readiness with:

```bash
curl -i http://localhost:3001/health
```

The expected result is `HTTP 204 No Content` with no response body.

The root `docker-compose.yml` can start PostgreSQL, the API, and the frontend together. See `../LOCAL_HOSTING.md` and review its volume-reset warning before deleting Docker data.

## Package and database scripts

### Server and validation

| Command | Purpose |
| --- | --- |
| `npm run dev` | Generate Prisma client, then run `src/index.ts` through ts-node |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run start` | Run `dist/index.js` |
| `npm run lint` | Run ESLint over `src` |
| `npm run prisma:generate` | Generate the Prisma client |
| `npm run prisma:migrate` | Run development migrations |
| `npm run prisma:studio` | Start Prisma Studio without opening a browser automatically |
| `npm run db:push` | Push schema state directly to the database |
| `npm run db:import-json` | Import legacy JSON data into PostgreSQL |
| `npm run backfill:notifications` | Run the notification backfill script |

### Seed scripts

The verified scripts are `seed`, `seed:list`, `seed:patients`, `seed:doctors`, `seed:staff`, `seed:inventory`, `seed:appointments`, `seed:finance`, and `seed:payment-methods`, with corresponding `delete:*` commands plus `delete:all` and `delete:seed`.

There is no backend automated test script in `package.json`.

## Build and deployment

### Production build

```bash
npm run prisma:generate
npm run build
npm run start
```

`npm run start` assumes `dist/` already exists.

### Render

The checked-in `render.yaml` defines the current deployment:

- Runtime: Node
- Plan: free
- Build: `npm ci && npm run prisma:generate && npm run build`
- Start: `npx prisma migrate deploy && npm start`
- Health path: `/health`
- Required deployment values: `DATABASE_URL`, the Vercel `FRONTEND_URL`, and a persistent `JWT_SECRET`
- Optional values: `DIRECT_URL` and additional comma-separated `FRONTEND_URLS`

If creating the service manually, use `villahermosadentalclinic-server` as the Render root directory and reproduce those commands and variables. Do not use the old `/api/health` JSON response as the primary Render probe; `/health` is the canonical readiness endpoint.

Keep `JWT_SECRET` stable across deploys. Changing it invalidates all existing JWTs.

## Health and startup behavior

Both health paths return exactly:

```text
HTTP 204 No Content
```

There is no JSON body. Responses disable caching. The frontend checks `/health` before backend-dependent authentication verification at the shared protected-route boundary.

When Render is asleep, the frontend polls health approximately every four seconds for up to 90 seconds and does not mount dashboard queries. Once health succeeds, it verifies the existing session. Health failure is therefore treated as availability trouble, not proof of invalid authentication.

Keep the health handler lightweight. Do not add authenticated work, large database queries, or response content to it without reconsidering the frontend readiness contract and Render configuration.

## CORS

The server enables credentialed CORS and constructs its allowlist from:

- `FRONTEND_URL`
- comma-separated `FRONTEND_URLS`
- verified local development origins
- the currently recognized production and Vercel host patterns in `src/index.ts`

Allowed methods include `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, and `OPTIONS`; allowed request headers include `Content-Type` and `Authorization`.

Because credentials are enabled, production origins must be explicit and use HTTPS. When a Vercel production or preview domain changes, update the environment allowlist rather than weakening CORS globally.

## Errors and logging

Controllers return structured JSON errors, and the server has a final error handler. Production responses avoid exposing stack traces, while server-side logs retain diagnostic context. Authentication verification intentionally returns temporary server failure for database/infrastructure problems instead of converting them to `401`.

When adding error handling:

- Use `401` only for definitive missing or invalid authentication.
- Use `403` for an authenticated user who lacks permission.
- Use temporary `5xx` responses for infrastructure failures.
- Do not include JWTs, passwords, connection strings, or private patient data in logs.
- Preserve audit snapshots for appointment, payment, finance, expense, inventory, and related changes by reusing existing helpers.

## Security notes

- Use a long, random `JWT_SECRET`; never use the development placeholder in production.
- Store database, SMTP, and authentication secrets only in environment configuration.
- Keep PostgreSQL TLS enabled for hosted production databases and understand any exception before disabling certificate verification.
- Preserve both `requireAuth` and applicable `requireRole` middleware when editing routes.
- Audit legacy routes before relying on them. Several predate the current protected-workspace model.
- Never re-enable a Disabled module just because its controller or route still compiles.
- Validate and normalize request input at the server boundary; UI validation is not sufficient.
- Do not introduce automatic write retries. A timed-out write may already be committed.
- Treat patient, appointment, payment, staff, and finance records as sensitive data.

## Troubleshooting

### `/health` does not return 204

Check Render/server logs, the configured start command, and whether server initialization completed. `/health` is only reachable after the Express process begins listening.

### Prisma cannot connect

Verify `DATABASE_URL`, provider network access, TLS requirements, and whether a direct or pooled port is expected. Use `DIRECT_URL` for migration operations when required by the provider. Ensure special characters in credentials are URL-encoded.

### Migrations fail during deployment

Run `npm run build` and `npm run prisma:generate` locally first. Inspect the versioned migrations and confirm Render can use the migration connection. Do not replace migration deployment with `db:push` as an undocumented workaround.

### Authentication works locally but not from Vercel

Confirm HTTPS, `FRONTEND_URL`/`FRONTEND_URLS`, the frontend `NEXT_PUBLIC_API_URL`, credentialed requests, and a stable `JWT_SECRET`. Cross-site production cookies require `Secure` and `SameSite=None`, which the server applies in production.

### Users are logged out after a deploy

Check whether `JWT_SECRET` changed. Since the project has no refresh tokens, JWTs signed by an older secret cannot be renewed.

### Seed data appears in the wrong database

All seed and delete scripts use the configured Prisma connection. Stop and inspect `.env` before running any mutation script, especially `delete:*` commands.

### Validation

Use the scripts that actually exist:

```bash
npm run prisma:generate
npm run build
npm run lint
```

There is no automated backend test command in the current package scripts.

## Related documentation

- [Frontend README](../villahermosa-dental-clinic/README.md)
- [Repository instructions for coding agents](../CLAUDE.md)
- [Seeder details](./SEEDER_README.md)
- [Local Docker hosting](../LOCAL_HOSTING.md)
- [Online hosting notes](../ONLINE_HOSTING.md)
