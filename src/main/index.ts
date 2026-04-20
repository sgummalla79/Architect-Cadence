import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, shell } from 'electron';
import * as path from 'path';
import {
  getJobConfigPath,
  loadJobConfig,
  readJobConfigRaw,
  resolveLoginUrl,
  saveJobConfigRaw,
  scaffoldSampleConfigIfMissing,
} from './job-config';
import { performOAuthFlow, DEFAULT_CLIENT_ID } from './oauth-flow';
import {
  clearSession,
  forceRefresh,
  getAccessToken,
  getMetadata,
  getPublicSession,
  initSessionFromDisk,
  installSession,
  isSignedIn,
} from './session';
import { createSalesforceClient } from './salesforce-client';
import { runJob, RunResult } from './job-runner';
import { appendLog, clearLogs, getLogPath, LogEntry, LogWindow, readLogs } from './log-store';
import { randomUUID } from 'crypto';
import { validateConfig } from '../shared';
import { isFirstLaunch, loadPrefs, savePrefs, isValidTime } from './prefs-store';
import { createScheduler, Scheduler } from './scheduler';
import { notifyScheduledRun } from './notifications';
import { getStartupStatus, isStartupSupported, setStartupEnabled, wasAutoLaunched } from './startup';

// On Windows, setAppUserModelId must be called before app.whenReady() so the
// OS associates the window and taskbar button with our app identity rather than
// the generic Electron binary. Without this, the taskbar always shows the
// Electron icon regardless of the BrowserWindow icon option.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.architectcadence.app');
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let scheduler: Scheduler | null = null;

// UI state (distinct from the auth session; this is just scheduling/display).
// Defaults here are overwritten from prefs.json in app.whenReady().
const state = {
  isActive: true,
  isConnected: false,
  scheduledTime: '23:00',
  username: null as string | null,
  orgDomain: null as string | null,
  launchAtStartup: false,
  startupSupported: true, // whether the OS supports launch-at-startup at all
};

function reflectSessionIntoUiState(): void {
  const meta = getPublicSession();
  if (meta) {
    state.isConnected = true;
    state.username = meta.username;
    state.orgDomain = hostnameOf(meta.instanceUrl);
  } else {
    state.isConnected = false;
    state.username = null;
    state.orgDomain = null;
  }
}

function hostnameOf(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

// ============ Dock visibility (macOS) ============
//
// When the window is hidden, we remove the app from the Dock entirely so it
// behaves like a "menu bar only" app (Rectangle, iStat Menus). When the
// window is shown, we put the app back in the Dock so Cmd+Tab works and the
// user has a normal app presence.
//
// macOS gotcha: app.dock.show() resets the dock icon to whatever's in the
// bundle's Info.plist. In dev that's Electron's default icon. We have to
// reapply our custom icon after every show() call, not just once at startup.
//
// No-op on Windows and Linux — `app.dock` only exists on macOS.

let cachedDockIcon: Electron.NativeImage | null = null;

function getDockIcon(): Electron.NativeImage | null {
  if (process.platform !== 'darwin') return null;
  if (cachedDockIcon) return cachedDockIcon;
  try {
    const iconPath = path.join(__dirname, '../icons/app-icon-512.png');
    const img = nativeImage.createFromPath(iconPath);
    if (!img.isEmpty()) {
      cachedDockIcon = img;
      return img;
    }
  } catch (err) {
    console.error(`[dock] Could not load icon: ${(err as Error).message}`);
  }
  return null;
}

function applyDockIcon(): void {
  if (process.platform !== 'darwin' || !app.dock) return;
  const img = getDockIcon();
  if (img) {
    try {
      app.dock.setIcon(img);
    } catch (err) {
      console.error(`[dock] setIcon failed: ${(err as Error).message}`);
    }
  }
}

function setDockVisible(visible: boolean): void {
  if (process.platform !== 'darwin') return;
  if (!app.dock) return;
  try {
    if (visible) {
      // show() returns a promise that resolves once the dock entry is fully
      // up. We reapply our custom icon both immediately (so there's no flash
      // of the Electron icon) and after show() resolves (because show()
      // itself resets the icon to the bundle default).
      applyDockIcon();
      void app.dock.show().then(() => applyDockIcon());
    } else {
      app.dock.hide();
    }
  } catch (err) {
    console.error(`[dock] ${(err as Error).message}`);
  }
}

// ============ Window / Tray ============

function createWindow(showOnReady: boolean): void {
  mainWindow = new BrowserWindow({
    width: 720,
    height: 760,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false, // always false initially — we show manually via the ready-to-show event
    frame: true,
    backgroundColor: '#0f1419',
    icon: process.platform === 'win32'
      ? path.join(__dirname, '../icons/app-icon.ico')
      : path.join(__dirname, '../icons/app-icon-256.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  // Tie the macOS Dock icon to window visibility. When the window is shown,
  // show the Dock icon; when hidden, remove the Dock icon entirely.
  mainWindow.on('show', () => setDockVisible(true));
  mainWindow.on('hide', () => setDockVisible(false));

  // Show the window only once it's painted — avoids a white flash on first paint.
  // If we were told to stay hidden (auto-launch), skip the show entirely; the
  // user will click the tray icon or "Show Window" menu item when they want it.
  if (showOnReady) {
    mainWindow.once('ready-to-show', () => {
      mainWindow?.show();
    });
  } else {
    // We're not showing the window at launch — make sure the Dock reflects that.
    setDockVisible(false);
  }

  mainWindow.on('close', (e) => {
    if (!(app as any).isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
    if (!showOnReady) {
      // In dev, show the window even if we were auto-launched, otherwise
      // debugging is a nightmare.
      mainWindow.once('ready-to-show', () => mainWindow?.show());
    }
  }
}

function createTray(): void {
  // macOS auto-recolors PNGs whose filename ends in `Template` (light/dark menu bar).
  // On Windows we use the colored version.
  const trayIconPath =
    process.platform === 'darwin'
      ? path.join(__dirname, '../icons/trayTemplate.png')
      : path.join(__dirname, '../icons/tray-32.png');

  const icon = nativeImage.createFromPath(trayIconPath);
  if (icon.isEmpty()) {
    console.warn(`[tray] Could not load tray icon from ${trayIconPath} — falling back to empty icon`);
  } else if (process.platform === 'darwin') {
    // Mark as template so macOS handles light/dark mode.
    icon.setTemplateImage(true);
  }

  tray = new Tray(icon);
  tray.setToolTip('Architect Cadence');
  updateTrayMenu();

  // Left-click pops up the same menu as right-click. This removes the old
  // "click shows window" shortcut — the only way to show the window is via
  // the "Show Window" menu item (intentional, tray-first UX).
  tray.on('click', () => {
    tray?.popUpContextMenu();
  });
}

function updateTrayMenu(): void {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: 'Open', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    {
      label: 'Run Now',
      enabled: state.isConnected,
      click: () => mainWindow?.webContents.send('tray:run-now'),
    },
    {
      label: state.isActive ? 'Disable Schedule' : 'Enable Schedule',
      click: () => {
        state.isActive = !state.isActive;
        savePrefs({
          isActive: state.isActive,
          scheduledTime: state.scheduledTime,
          launchAtStartup: state.launchAtStartup,
        });
        scheduler?.reconfigure({ scheduledTime: state.scheduledTime, active: state.isActive });
        updateTrayMenu();
        mainWindow?.webContents.send('state:changed', state);
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => { (app as any).isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

// Persist a completed run to disk + push it to the renderer's log panel.
function recordRun(result: RunResult): void {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level: result.ok ? 'success' : 'error',
    message: `${result.ok ? '✓' : '✗'} ${result.message}`,
    durationMs: result.durationMs,
    matchedCount: result.matchedCount,
    updatedCount: result.updatedCount,
    failedCount: result.failedCount,
    recordIds: result.recordIds.length > 0 ? result.recordIds : undefined,
    runId: randomUUID(),
  };
  try {
    appendLog(entry);
  } catch (err) {
    console.error(`[log] Failed to persist log entry: ${(err as Error).message}`);
  }
  mainWindow?.webContents.send('log:append', entry);
}

// ============ IPC ============

ipcMain.handle('state:get', () => state);

ipcMain.handle('state:set-active', (_e, isActive: boolean) => {
  state.isActive = isActive;
  savePrefs({
    isActive: state.isActive,
    scheduledTime: state.scheduledTime,
    launchAtStartup: state.launchAtStartup,
  });
  scheduler?.reconfigure({ scheduledTime: state.scheduledTime, active: state.isActive });
  updateTrayMenu();
  return state;
});

ipcMain.handle('state:set-time', (_e, time: string) => {
  console.log(`[ipc] state:set-time received: '${time}'`);
  if (!isValidTime(time)) {
    console.warn(`[ipc] state:set-time REJECTED — invalid format: '${time}'`);
    return state;
  }
  state.scheduledTime = time;
  savePrefs({
    isActive: state.isActive,
    scheduledTime: state.scheduledTime,
    launchAtStartup: state.launchAtStartup,
  });
  console.log(`[ipc] Prefs saved: time=${time}, active=${state.isActive}`);
  scheduler?.reconfigure({ scheduledTime: state.scheduledTime, active: state.isActive });
  return state;
});

ipcMain.handle('state:set-launch-at-startup', (_e, enabled: boolean) => {
  if (!state.startupSupported) {
    console.warn('[ipc] set-launch-at-startup called on unsupported platform');
    return state;
  }
  const result = setStartupEnabled(Boolean(enabled));
  state.launchAtStartup = result.enabled;
  savePrefs({
    isActive: state.isActive,
    scheduledTime: state.scheduledTime,
    launchAtStartup: state.launchAtStartup,
  });
  console.log(`[startup] Launch-at-startup set to ${state.launchAtStartup}`);
  return state;
});

// --- Module 4: real Run Now ---

ipcMain.handle('action:run-now', async () => {
  const result = await executeJob();
  recordRun(result);
  return { ok: result.ok, message: result.message };
});

async function executeJob(): Promise<RunResult> {
  if (!isSignedIn()) {
    return {
      ok: false,
      mode: 'error',
      matchedCount: 0,
      recordIds: [],
      message: 'Not signed in. Click "Sign in to Salesforce" in Settings.',
      durationMs: 0,
      startedAt: new Date().toISOString(),
    };
  }

  const configResult = loadJobConfig();
  if (!configResult.ok) {
    return {
      ok: false,
      mode: 'error',
      matchedCount: 0,
      recordIds: [],
      message: `Config error: ${configResult.errors.join('; ')}`,
      durationMs: 0,
      startedAt: new Date().toISOString(),
    };
  }

  const meta = getMetadata()!;
  const client = createSalesforceClient({
    instanceUrl: meta.instanceUrl,
    apiVersion: configResult.config.apiVersion,
    getAccessToken: () => getAccessToken(),
    forceRefresh: () => forceRefresh(),
  });

  return runJob({
    config: configResult.config,
    isActive: state.isActive,
    client,
    currentUserId: meta.userId,
  });
}

// --- Auth ---

ipcMain.handle('action:sign-in', async () => {
  try {
    const loginUrl = resolveLoginUrl();
    console.log(`[oauth] Starting sign-in flow against ${loginUrl}`);

    const result = await performOAuthFlow({
      loginUrl,
      clientId: DEFAULT_CLIENT_ID,
      openBrowser: (url) => { void shell.openExternal(url); },
    });

    if (!result.tokens.refresh_token) {
      throw new Error('No refresh token returned. Ensure the Connected App has the "refresh_token" scope.');
    }

    installSession({
      accessToken: result.tokens.access_token,
      refreshToken: result.tokens.refresh_token,
      metadata: {
        userId: result.userInfo.user_id,
        username: result.userInfo.username,
        instanceUrl: result.tokens.instance_url,
        loginUrl,
        organizationId: result.userInfo.organization_id,
        lastRefreshedAt: new Date().toISOString(),
      },
    });

    reflectSessionIntoUiState();
    updateTrayMenu();
    console.log(`[oauth] Signed in as ${result.userInfo.username}`);
    return { ok: true, state };
  } catch (err) {
    const message = (err as Error).message ?? 'Sign-in failed';
    console.error(`[oauth] ${message}`);
    return { ok: false, state, message };
  }
});

ipcMain.handle('action:reset-connection', () => {
  clearSession();
  reflectSessionIntoUiState();
  updateTrayMenu();
  return { ok: true, state };
});

ipcMain.handle('action:test-connection', async () => {
  if (!isSignedIn()) return { ok: false, message: 'Not connected' };
  try {
    await getAccessToken(true);
    const meta = getMetadata()!;
    return { ok: true, message: `Connected as ${meta.username}` };
  } catch (err) {
    return { ok: false, message: `Test failed: ${(err as Error).message}` };
  }
});

// --- Config (in-app editor) ---

ipcMain.handle('config:read', () => {
  // Auto-scaffold so the editor is never empty on first launch.
  scaffoldSampleConfigIfMissing();
  const text = readJobConfigRaw();
  return { ok: true, text };
});

ipcMain.handle('config:validate', (_e, rawText: string) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    return { ok: false, errors: [`Not valid JSON: ${(err as Error).message}`] };
  }
  const v = validateConfig(parsed);
  return v.ok
    ? { ok: true, message: `Config valid — object: ${v.config.object}` }
    : { ok: false, errors: v.errors };
});

ipcMain.handle('config:save', (_e, rawText: string) => {
  const result = saveJobConfigRaw(rawText);
  if (!result.ok) return { ok: false, errors: result.errors };
  return { ok: true, formatted: result.formatted, message: 'Config saved' };
});

// --- Paths (About tab) ---

ipcMain.handle('paths:get', () => {
  return {
    configPath: getJobConfigPath(),
    logPath: getLogPath(),
  };
});

ipcMain.handle('logs:get', (_e, window: LogWindow) => {
  try {
    return { ok: true, entries: readLogs(window) };
  } catch (err) {
    return { ok: false, entries: [] as LogEntry[], message: (err as Error).message };
  }
});

ipcMain.handle('logs:clear', () => {
  try {
    clearLogs();
    return { ok: true };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
});

// ============ Lifecycle ============

app.whenReady().then(() => {
  // Load user prefs (Active toggle + scheduled time) before the window opens
  // so the UI paints the correct state immediately.
  try {
    const prefs = loadPrefs();
    state.isActive = prefs.isActive;
    state.scheduledTime = prefs.scheduledTime;
    state.launchAtStartup = prefs.launchAtStartup;
    console.log(`[prefs] Loaded: active=${state.isActive}, time=${state.scheduledTime}, launchAtStartup=${state.launchAtStartup}`);
  } catch (err) {
    console.error(`[prefs] Could not load: ${(err as Error).message}`);
  }

  // Reconcile launch-at-startup with the OS. The user may have toggled it off
  // via System Settings while the app wasn't running; we trust the OS as the
  // source of truth and update prefs.json to match.
  state.startupSupported = isStartupSupported();
  if (state.startupSupported) {
    const osStatus = getStartupStatus();
    if (osStatus.enabled !== state.launchAtStartup) {
      console.log(
        `[startup] Prefs said launchAtStartup=${state.launchAtStartup} but OS reports ${osStatus.enabled}; trusting OS`
      );
      state.launchAtStartup = osStatus.enabled;
      savePrefs({
        isActive: state.isActive,
        scheduledTime: state.scheduledTime,
        launchAtStartup: state.launchAtStartup,
      });
    }
  } else {
    state.launchAtStartup = false;
    console.log(`[startup] Launch-at-startup not supported on ${process.platform}`);
  }

  // Create sample config on very first run so there's something to sign in against.
  try {
    if (scaffoldSampleConfigIfMissing()) {
      console.log(`[config] Created sample config at ${getJobConfigPath()}`);
    }
  } catch (err) {
    console.error(`[config] Could not scaffold sample: ${(err as Error).message}`);
  }

  try {
    if (initSessionFromDisk()) {
      reflectSessionIntoUiState();
      console.log(`[oauth] Restored session for ${state.username}`);
    }
  } catch (err) {
    console.error(`[oauth] Could not restore session: ${(err as Error).message}`);
  }

  // Start the scheduler. onTick runs the same job pipeline as Run Now,
  // and additionally fires an OS notification on failure.
  scheduler = createScheduler({
    scheduledTime: state.scheduledTime,
    active: state.isActive,
    onTick: async () => {
      const result = await executeJob();
      recordRun(result);
      notifyScheduledRun(result, { getMainWindow: () => mainWindow });
    },
  });
  console.log(
    `[scheduler] Configured for ${state.scheduledTime} local time (${state.isActive ? 'enabled' : 'paused'})`
  );

  // In dev (`npm start`), the Mac dock shows Electron's default icon because
  // the binary is Electron.app. Override it manually so the dock matches our
  // app. Packaged builds (Module 9) will get this from the .icns in Info.plist.
  applyDockIcon();

  // Decide whether to show the window on this launch.
  //   - Always show on first-ever launch (so the user knows the install worked)
  //   - Stay hidden if the OS auto-launched us at login (tray-first UX)
  //   - Otherwise show (the user manually launched the app, they want to see it)
  const firstLaunch = isFirstLaunch();
  const autoLaunched = wasAutoLaunched();
  const shouldShowWindow = firstLaunch || !autoLaunched;
  console.log(
    `[launch] firstLaunch=${firstLaunch}, autoLaunched=${autoLaunched}, shouldShowWindow=${shouldShowWindow}`
  );

  // If we're starting hidden, hide the Dock icon as early as possible so it
  // doesn't flash visible during window creation.
  if (!shouldShowWindow) {
    setDockVisible(false);
  }

  createWindow(shouldShowWindow);
  createTray();

  // On macOS, clicking the dock icon or re-opening the app → show the window.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(true);
    } else {
      mainWindow?.show();
    }
  });
});

app.on('window-all-closed', () => { /* tray app — don't quit */ });
app.on('before-quit', () => {
  (app as any).isQuitting = true;
  scheduler?.stop();
});