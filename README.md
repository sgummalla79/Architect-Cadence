# Architect Cadence

Scheduled Salesforce data updates — desktop app for macOS and Windows.

## Status

🚧 **Module 1: UI Scaffold** — complete.
All buttons wired, no real Salesforce logic yet. Perfect for visual feedback before we add the real functionality.

## Getting started

```bash
npm install
npm start
```

If you want DevTools open on launch:

```bash
npm run dev
```

> **Note:** On first run you may see a security prompt (Mac asks permission for the tray icon, Windows Defender may inspect the build). This is expected for unsigned apps and will go away once we add code-signing in Module 9.

## Keeping dependencies current

This project pins `electron@^41` (current stable as of April 2026). Electron's support policy is the latest 3 majors — currently 39, 40, and 41. When Electron 42 lands, bump `electron` in `package.json` rather than running `npm audit fix --force` (force can sometimes downgrade to "compatible" older versions that introduce *more* problems).

Check audit status anytime with:

```bash
npm audit
```

Should always report **0 vulnerabilities** on a fresh install.

## What's in Module 1

✅ Project scaffold: Electron + TypeScript
✅ Two-tab UI: **Schedule** (main screen) and **Settings**
✅ Tray icon with menu (Show, Run Now, Enable/Disable Schedule, Quit)
✅ Window hides to tray on close (doesn't quit)
✅ Active/Inactive toggle (with visual state change on icon + pill)
✅ Time picker with "next run" indicator
✅ Sign In / Reset / Test Connection buttons (mocked — will fake a successful sign-in for visual testing)
✅ Config summary panel with Edit / Validate buttons
✅ Logs panel with Clear button
✅ Toast notifications for user feedback

## What to test

1. **Tab switching** — click between Schedule and Settings tabs.
2. **Schedule tab, disconnected state:**
   - Org bar shows "Not connected" with gray dot
   - "Run Now" is disabled
   - Active/Inactive pill toggles, icon changes color with it
   - Time picker works; "next run" updates
   - "Clear" on an empty log panel does nothing visible (no error)
3. **Settings tab → Connection:**
   - Click "Sign in to Salesforce" → mocks a successful sign-in
   - Connection panel now shows "Connected as jdoe@exp-cloud.com"
   - Sign In button disables, Test Connection + Reset enable
   - Org bar on Schedule tab updates to green
   - "Run Now" on Schedule tab becomes enabled
4. **Run Now (after sign-in):**
   - Click "Run Now" on Schedule tab → a log entry appears
   - Click "Clear" → log display empties
5. **Test Connection** → toast "Connected as ..."
6. **Reset Connection** → confirm dialog → reverts to disconnected state
7. **Tray icon** (menu bar on Mac, system tray on Windows):
   - Click tray icon → window shows/hides
   - Right-click tray → menu with Show / Run Now / Enable|Disable / Quit
   - "Enable/Disable Schedule" from tray updates the main UI live
   - "Quit" actually exits the app (normal close just hides)

## Known limitations in Module 1

- All "Sign in" does is flip a boolean — no real OAuth yet (Module 3).
- "Run Now" logs a stub message — no Salesforce call yet (Module 4).
- "Edit Config" / "Validate" are stubs — no JSON read/write yet (Module 2).
- Active toggle & time don't persist across restarts — coming in Module 6.
- Tray icon is blank (no visible image) — will add in Module 8.
- No OS notifications yet (Module 7).

## Project structure

```
architect-cadence/
├── src/
│   ├── main/index.ts        # Electron main: window, tray, IPC stubs
│   ├── preload/preload.ts   # Safe IPC bridge
│   └── renderer/
│       ├── index.html       # UI markup (tabs + all panels)
│       ├── styles.css       # Dark theme matching the mockup
│       └── app.ts           # UI state + button handlers
├── scripts/copy-assets.js   # Copies HTML/CSS to dist/ after tsc
├── package.json
└── tsconfig.json
```

## Next up: Module 2

SOQL builder + config validator — pure logic, no Electron involved. Unit-testable with Jest.
Takes your JSON config → outputs valid SOQL with the owner filter appended.