# Architect Cadence

Scheduled Salesforce data updates — desktop app for macOS and Windows.

A small tray app that runs a configurable SOQL-based update job against a Salesforce org on a daily schedule. Built to do one thing well: scoped, guardrailed, auditable record updates.

## Status

Modules 1–5 complete. The app installs, signs in to a real Salesforce org via OAuth PKCE, runs the configured job on demand, and persists logs across restarts. Daily scheduling, OS notifications, launch-on-boot, and packaging come in Modules 6–9.

```
✅ Module 1: UI scaffold (Electron + TypeScript)
✅ Module 2: SOQL builder + config validator (91 tests)
✅ Module 3: OAuth PKCE + keychain-backed token storage (27 tests)
✅ Module 4: Job runner with guardrail (21 tests)
✅ Module 5: Persistent logs with retention + windowed views (17 tests)
🚧 Module 6: Scheduler + Active toggle persistence
⏳ Module 7: OS notifications
⏳ Module 8: Launch on boot, real tray icon
⏳ Module 9: Code-signed installers (.dmg, .exe)
```

**159/159 tests passing.** **0 npm vulnerabilities.**

## Quick start

```bash
npm install
npm test       # 159 passed
npm start      # opens the app
```

For DevTools on launch: `npm run dev`.

On first launch, a sample config is created at `~/Library/Application Support/architect-cadence/job-config.json` (or the OS equivalent). Edit it via Settings → Job Configuration in the app.

## How it works

1. **Sign in** — Settings tab → "Sign in to Salesforce" opens a system-browser OAuth flow (PKCE, no secrets in the binary). Refresh token is encrypted via Electron `safeStorage` (macOS Keychain / Windows DPAPI) and persisted across restarts. Access tokens live only in memory.

2. **Configure the job** — Settings tab → Job Configuration. The full JSON config is editable in-app with Edit / Validate / Save. Save validates first, refuses invalid input, and auto-formats with 2-space indentation.

3. **Run on demand** — Schedule tab → Run Now. The runner:
   - Builds SOQL from the config (filters + nested logic + auto-appended owner filter)
   - Queries with `LIMIT maxRecords + 1` as the guardrail check
   - **If the result count exceeds `maxRecords`, the update is skipped** and the run is logged as an error
   - Otherwise PATCH /composite/sobjects to update matched records

4. **Inspect history** — Execution History dropdown shows last run / 3 / 7 / 15 / 30 days. Each entry shows duration; click the disclosure button to view the record IDs that were touched. Logs survive restarts.

## Configuration

Example `job-config.json`:

```json
{
  "domain": "exp-cloud.my.salesforce.com",
  "apiVersion": "v66.0",
  "logLevel": "info",
  "object": "Student__c",
  "filters": {
    "conditions": [
      { "field": "Final_Result__c", "operator": "=",  "value": "Withdrawn" },
      { "field": "Id",              "operator": "IN", "value": [
        "a0uKd00000L6xfQIAR",
        "a0uKd00000L6xfRIAR"
      ]}
    ],
    "logic": "1 AND 2"
  },
  "ownerFieldName": "OwnerId",
  "updateFields": [
    { "field": "Final_Result__c", "value": "Distinction" }
  ],
  "maxRecords": 15
}
```

**Field reference:**

| Field | Purpose |
|---|---|
| `domain` | Salesforce My Domain (used for OAuth login URL) |
| `apiVersion` | REST API version, e.g. `v66.0` |
| `object` | sObject API name to query and update |
| `filters.conditions` | Array of `{field, operator, value}` |
| `filters.logic` | Expression like `1 AND (2 OR 3)` referencing 1-indexed conditions |
| `ownerFieldName` | Field always constrained to the authenticated user's ID (safety) |
| `updateFields` | Fields to set on every matched record |
| `maxRecords` | Guardrail: if SOQL matches more than this, the update is **skipped** and an error is logged |
| `logLevel` | Optional: `debug` / `info` / `warn` / `error` |

**Supported operators:** `=`, `!=`, `<`, `>`, `<=`, `>=`, `LIKE`, `IN`.

**Owner filter:** the runner always appends `AND <ownerFieldName> = '<currentUserId>'` to the WHERE clause regardless of what `logic` says. This means the scheduled job can only ever touch records owned by the signed-in user — defense-in-depth against misconfigured filters.

## Standalone test scripts

Two scripts let you verify pieces of the system outside Electron:

```bash
# Test OAuth flow against your real org (interactive, no writes)
npm run test:oauth

# Dry-run the full job (SELECT only, no writes)
npm run test:run

# Actually execute the UPDATE
npm run test:run -- --update

# Use a separate config (recommended for first real --update)
npm run test:run -- --config ./test-config.json --update
```

`test:run` defaults to dry-run on purpose — you'd have to opt in to writing.

## Project structure

```
architect-cadence/
├── src/
│   ├── main/
│   │   ├── index.ts                 # Window, tray, IPC handlers
│   │   ├── oauth.ts                 # Pure OAuth helpers (PKCE, URL build, callback parse)
│   │   ├── oauth-flow.ts            # Loopback server + token exchange
│   │   ├── token-store.ts           # safeStorage wrapper for refresh token
│   │   ├── session.ts               # In-memory session + auto-refresh
│   │   ├── salesforce-client.ts     # Native-fetch wrapper, 401 retry, token scrubbing
│   │   ├── job-runner.ts            # SELECT + guardrail + UPDATE orchestration
│   │   ├── job-config.ts            # Read / validate / save config file
│   │   ├── log-store.ts             # File I/O for JSONL logs
│   │   ├── log-store-core.ts        # Pure log helpers (no Electron, testable)
│   │   └── __tests__/
│   ├── preload/
│   │   └── preload.ts               # Safe IPC bridge to renderer
│   ├── renderer/
│   │   ├── index.html               # Tabbed UI (Schedule / Settings / About)
│   │   ├── styles.css
│   │   └── app.ts                   # UI state + handlers
│   └── shared/
│       ├── types.ts                 # JobConfig schema types
│       ├── logic-parser.ts          # Logic expression parser (recursive descent)
│       ├── soql-builder.ts          # AST + conditions → SOQL string
│       ├── config.ts                # Validator
│       └── __tests__/
├── scripts/
│   ├── copy-assets.js               # Build helper (HTML/CSS into dist)
│   ├── test-oauth.ts                # Standalone OAuth verification
│   └── test-run.ts                  # Standalone job-runner verification
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## Security notes

- **Refresh token** is encrypted at rest via `safeStorage`. Never written in plaintext.
- **Access token** is held only in the main process memory. Never persisted, never sent to the renderer, never logged.
- **All sign-in** uses OAuth PKCE; no client secrets are embedded in the binary.
- **All API calls** are HTTPS to Salesforce; the only inbound port we open is `localhost:1717` during the brief OAuth callback window, then closed.
- **Token-shaped strings** are scrubbed from any error message that could reach logs or UI.
- **Owner filter** is always AND-appended to the WHERE clause — the job can only modify records owned by the authenticated user.
- **Guardrail** prevents accidental mass-updates if a filter is too broad.

## Where the app stores data

| File | What | Encrypted? |
|---|---|---|
| `~/Library/Application Support/architect-cadence/job-config.json` | Job configuration | No (no secrets) |
| `~/Library/Application Support/architect-cadence/session.json` | Username, instance URL, user ID, org ID | No (no secrets) |
| `~/Library/Application Support/architect-cadence/session.enc` | Refresh token | Yes (`safeStorage`) |
| `~/Library/Application Support/architect-cadence/logs.jsonl` | Run history (30-day retention) | No |

(Paths shown for macOS — Windows uses `%APPDATA%\architect-cadence\`, Linux uses `~/.config/architect-cadence/`.)

## Window behavior

- Fixed size 720×760 (not resizable, not maximizable, not full-screen-able)
- Tray-first: closing the window hides it; quit only via tray menu → Quit
- On macOS, the green maximize button is disabled

## Keeping dependencies current

Pinned to `electron@^41` (current stable). When Electron 42 lands, bump the version explicitly rather than running `npm audit fix --force`.

```bash
npm audit
```

Should always report **0 vulnerabilities** on a fresh install.

## Stack

- **Electron 41** + **TypeScript 5** (main process + preload)
- **Vanilla HTML/CSS/TS** for the renderer (no React; the UI is small enough)
- **Vitest 4** for tests (159 tests across pure helpers and main-process modules)
- **Native `fetch`** for Salesforce API calls (no `jsforce` — saves ~400KB of dependencies for a 2-call surface)

## What's coming

- **Module 6** — node-cron scheduler, persisted Active toggle and run time
- **Module 7** — Native OS notifications on success/failure
- **Module 8** — Real tray icon, launch on system boot via `app.setLoginItemSettings()`
- **Module 9** — `electron-builder` packaging (.dmg, .exe), code signing, optional auto-updater