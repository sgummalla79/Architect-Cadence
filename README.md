# Architect Cadence

A small menu-bar app that runs scheduled Salesforce data updates — configurable SOQL queries with safety guardrails, daily cadence, auditable logs, OS notifications.

Desktop app for **macOS** and **Windows**. Built on Electron + TypeScript.

---

## What it does

1. Sign in to a Salesforce org via browser-based OAuth (no client secrets in the binary).
2. Configure a query + update rule in JSON (sObject, filters with nested AND/OR logic, fields to update, a guardrail `maxRecords` ceiling).
3. Run it on demand, or schedule it to fire daily at a specific time.
4. Get notified on macOS/Windows when scheduled runs succeed or fail.
5. Browse execution history (last run / 3 / 7 / 15 / 30 days) with record IDs for every run.

The app lives in your menu bar/system tray. Close the window, it keeps running. Quit only via the tray menu.

---

## Running from source

If you just want to use the app on your own machine and don't need a signed installer, this is the simplest path.

### Prerequisites

- **Node.js 20+** and **npm 10+**
- **Git**
- **macOS** or **Windows** (Linux works for dev, but launch-at-startup is a no-op there)

### Install + run

```bash
git clone <your-repo-url> architect-cadence
cd architect-cadence
npm install
npm test         # should say 192 passed
npm start        # opens the app
```

First launch creates a sample config at:
- **macOS:** `~/Library/Application Support/architect-cadence/job-config.json`
- **Windows:** `%APPDATA%\architect-cadence\job-config.json`

Edit it via **Settings → Job Configuration** in the app (no need to touch the file directly).

### Development mode

```bash
npm run dev     # opens with DevTools already attached
```

### Useful scripts

```bash
npm test                  # 192 unit tests
npm run test:watch        # vitest watch mode
npm run test:oauth        # standalone OAuth flow verification (interactive, no writes)
npm run test:run          # dry-run the job against your org (SELECT only)
npm run test:run -- --update    # actually execute the UPDATE
```

Both `test:oauth` and `test:run` open a browser for sign-in each time (they can't decrypt the Electron app's stored refresh token, by design). For casual verification, both scripts use a config at the same path as the app.

---

## Building a distributable installer

If you want to ship a `.dmg` / `.exe` to yourself or others, this is the path.

### Build a macOS `.dmg`

On a Mac:

```bash
cd architect-cadence
npm install
npm run dist:mac
```

Output: `dist-installers/Architect Cadence-0.1.0-universal.dmg`

The `.dmg` is a universal binary — runs on both Intel and Apple Silicon Macs. To install:

1. Double-click the `.dmg`
2. Drag **Architect Cadence.app** to the **Applications** folder
3. Eject the disk image

First launch from Applications:
- macOS Gatekeeper will say "Architect Cadence cannot be opened because it is from an unidentified developer"
- **Right-click the app → Open → Open** in the confirmation dialog
- After that one-time bypass, macOS trusts it for all future launches on this machine

Once signed (see "Code signing" below), the bypass won't be needed.

### Build a Windows `.exe`

On Windows:

```bash
cd architect-cadence
npm install
npm run dist:win
```

Output: `dist-installers\Architect Cadence-Setup-0.1.0.exe`

The `.exe` is an NSIS installer. Double-click, follow the wizard, pick an install directory.

SmartScreen may show an "unrecognized app" warning the first time. Click **More info → Run anyway**. Code signing eliminates this warning (see below).

### Cross-platform notes

- On a Mac, you can also build the Windows installer with `npm run dist:win`, but it requires `wine` to be installed (`brew install --cask wine-stable`). Easier path: build Mac installers on Mac, Windows installers on Windows.
- On Windows, you **cannot** build a `.dmg` — macOS signing tools are macOS-only.

### Output size

- macOS universal DMG: ~200 MB (both architectures embedded)
- Windows x64 EXE: ~90 MB

If size matters, the build config supports `--x64` / `--arm64` instead of universal — halves the Mac output but requires two separate downloads.

---

## First-time setup in the app

After install:

1. **Connection tab** → "Sign in to Salesforce"  
   Opens your default browser. Sign in, authorize the app. The app captures the token and encrypts the refresh token in your OS keychain.

2. **Settings tab → Job Configuration** → "Edit"  
   Adjust the sample config to match your org:
   - `domain` — your My Domain (e.g. `acme.my.salesforce.com`)
   - `object` — the sObject to query and update
   - `filters` — conditions + a logic expression like `"1 AND (2 OR 3)"`
   - `updateFields` — what to set on each matched record
   - `maxRecords` — the safety ceiling; if a run matches more than this, it's skipped and logged as an error

   Click **Validate** to check, then **Save** (auto-formats with 2-space indent).

3. **Schedule tab**  
   Set the daily run time (24-hour picker). Toggle Active on. The job will fire at that local time every day.

4. **Run Now** (first time)  
   Click once to verify end-to-end. Check the Execution History — you should see a success entry with record IDs.

5. **Optional: Settings → Startup → Launch at startup**  
   Turn on to have the app auto-launch when you log in. It boots to the tray silently, no window shown.

---

## How runs are scoped (important)

For safety, **every query is automatically constrained to records owned by the authenticated user**:

```
WHERE (your filters) AND OwnerId = '<authenticated-user-id>'
```

This is appended by the runner regardless of what your `filters.logic` says. You cannot configure the app to touch records owned by other users — even if you try. This is a deliberate defense against misconfigured filters.

The `maxRecords` guardrail is the other half: if the SELECT returns more than `maxRecords`, the UPDATE is skipped and the run is logged as an error. No records are modified.

---

## Configuration reference

Example `job-config.json`:

```json
{
  "domain": "acme.my.salesforce.com",
  "apiVersion": "v66.0",
  "logLevel": "info",
  "object": "Student__c",
  "filters": {
    "conditions": [
      { "field": "Final_Result__c", "operator": "=",  "value": "Withdrawn" },
      { "field": "Id",              "operator": "IN", "value": ["a0uKd00000L6xfQIAR"] }
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

| Field | Purpose |
|---|---|
| `domain` | Your Salesforce My Domain |
| `apiVersion` | REST API version, e.g. `v66.0` |
| `object` | sObject API name |
| `filters.conditions` | Array of `{field, operator, value}` |
| `filters.logic` | Expression like `1 AND (2 OR 3)` referencing 1-indexed conditions |
| `ownerFieldName` | Field always constrained to the signed-in user's ID |
| `updateFields` | Fields to set on every matched record |
| `maxRecords` | Guardrail — runs exceeding this are skipped |
| `logLevel` | `debug` / `info` / `warn` / `error` (optional) |

Supported operators: `=`, `!=`, `<`, `>`, `<=`, `>=`, `LIKE`, `IN`.

---

## Where data lives

Paths shown for macOS — Windows uses `%APPDATA%\architect-cadence\`.

| File | What | Encrypted? |
|---|---|---|
| `job-config.json` | Job configuration | No |
| `session.json` | Username, instance URL, user ID, org ID | No |
| `session.enc` | Refresh token | Yes (OS keychain) |
| `logs.jsonl` | Run history, 30-day retention | No |
| `prefs.json` | Active toggle, scheduled time, launch-at-startup | No |

Access tokens are never written to disk — they live in memory only, never cross to the renderer process, and are scrubbed from any error message that might end up in logs.

---

## Code signing (optional but recommended for distribution)

Unsigned installers work fine for personal use but trigger OS warnings on other machines. Signing eliminates those warnings.

### macOS (Apple Developer ID)

Costs $99/year via Apple. Once you have a Developer ID certificate:

```bash
export CSC_LINK=/path/to/DeveloperID.p12
export CSC_KEY_PASSWORD=your-p12-password

# For notarization (required for macOS 10.15+):
export APPLE_ID=your@apple.id
export APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
export APPLE_TEAM_ID=XXXXXXXXXX

npm run dist:mac
```

The build will sign, notarize, and staple automatically. Users get no Gatekeeper warnings.

### Windows (Authenticode)

Get an OV or EV code signing certificate from a CA (DigiCert, Sectigo, etc.):

```bash
export CSC_LINK=/path/to/cert.pfx
export CSC_KEY_PASSWORD=your-pfx-password

npm run dist:win
```

EV certificates provide immediate SmartScreen reputation. OV certificates need to build reputation over time (more downloads = less warnings).

Without signing, the installer still works — users just get a "from an unknown publisher" prompt.

---

## Troubleshooting

**"Run Now" is greyed out**  
You're not signed in. Connection tab → Sign in to Salesforce.

**Scheduler isn't firing**  
Check the terminal output when you run `npm start` — you should see `[scheduler] Installed cron '...'`. If the time picker changes aren't logged at `[ipc] state:set-time received: ...`, the IPC bridge isn't wired — try a full `rm -rf dist && npm start`.

**`npm test` failures after `npm install`**  
Run `npm run clean && npm install`. This rebuilds native deps against the current Electron version.

**First run on macOS says "cannot be opened"**  
Right-click the app in Applications → Open → Open. One-time bypass, persists after that.

**Where are my logs?**  
About tab shows the path to `logs.jsonl`. You can open it in any text editor — one JSON object per line, newest at the bottom. Entries older than 30 days get pruned automatically.

**Window won't come back after closing**  
By design — close hides to tray. Click the tray icon → "Show Window".

---

## Tech stack

- **Electron 41** + **TypeScript 5**
- **node-cron 4** for scheduling
- **Vitest 4** for tests (192 passing, 0 vulnerabilities)
- Vanilla HTML/CSS for the renderer (no React)
- Native `fetch` for Salesforce API calls

---

## License

MIT