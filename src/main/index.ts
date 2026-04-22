import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, shell } from 'electron';
import * as path from 'path';
import {
  getAppConfigPath,
  loadAppConfig,
  migrateConfigFilename,
  readAppConfigRaw,
  resolveLoginUrl,
  saveAppConfigRaw,
  scaffoldSampleConfigIfMissing,
} from './app-config';
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
import { createSalesforceClient, SalesforceApiError, scrubTokens } from './salesforce-client';
import { runJob, RunResult } from './job-runner';
import { appendLog, clearLogs, getLogPath, LogEntry, LogLevel, LogSource, LogWindow, readLogs } from './log-store';
import { randomUUID } from 'crypto';
import { buildEngagementsSOQL, validateConfig } from '../shared';
import { isFirstLaunch, loadPrefs, savePrefs, isValidTime } from './prefs-store';
import { createScheduler, Scheduler } from './scheduler';
import { notifyScheduledRun } from './notifications';
import { getStartupStatus, isStartupSupported, setStartupEnabled, wasAutoLaunched } from './startup';

// On Windows, setAppUserModelId must be called before app.whenReady() so the
// OS associates the window and taskbar button with our app identity rather than
// the generic Electron binary. Without this, the taskbar always shows the
// Electron icon regardless of the BrowserWindow icon option.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.architectcompanion.app');
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
    autoHideMenuBar: true,
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

  if (process.platform === 'win32') Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  // On macOS: keep the dock icon always visible. Close button closes the window
  // (standard macOS app behavior) — the app stays alive in the dock with no
  // open windows. Clicking the dock icon re-opens the window.
  // On Windows/Linux: retain the old hide-to-tray behavior.
  if (process.platform === 'darwin') {
    setDockVisible(true);
  } else {
    mainWindow.on('show', () => setDockVisible(true));
    mainWindow.on('hide', () => setDockVisible(false));
  }

  // Show the window only once it's painted — avoids a white flash on first paint.
  if (showOnReady) {
    mainWindow.once('ready-to-show', () => {
      mainWindow?.show();
    });
  } else if (process.platform !== 'darwin') {
    setDockVisible(false);
  }

  mainWindow.on('close', (e) => {
    if ((app as any).isQuitting) return; // full quit — let it close
    if (process.platform !== 'darwin') {
      // Windows/Linux: hide to tray instead of closing.
      e.preventDefault();
      mainWindow?.hide();
    }
    // macOS: let the window close naturally; app stays alive in dock.
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
  tray.setToolTip('Architect Companion');
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

function pushLog(entry: LogEntry): void {
  try {
    appendLog(entry);
  } catch (err) {
    console.error(`[log] Failed to persist log entry: ${(err as Error).message}`);
  }
  mainWindow?.webContents.send('log:append', entry);
}

// Persist a completed scheduler run to disk + push it to the renderer's log panel.
// Also signals the renderer to refresh the engagements tab so it reflects any status changes.
function recordRun(result: RunResult, runId: string): void {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level: result.ok ? 'success' : 'error',
    message: `${result.ok ? '✓' : '✗'} ${result.message}`,
    source: 'scheduler',
    durationMs: result.durationMs,
    matchedCount: result.matchedCount,
    updatedCount: result.updatedCount,
    failedCount: result.failedCount,
    recordIds: result.recordIds.length > 0 ? result.recordIds : undefined,
    runId,
  };
  pushLog(entry);
  mainWindow?.webContents.send('engagements:refresh');
}

// Emit a scheduler step log (query, update, warn, etc.) with the run's runId for grouping.
function logScheduler(level: LogLevel, message: string, runId: string): void {
  pushLog({ ts: new Date().toISOString(), level, message, source: 'scheduler', runId });
}

// Emit an engagement operation log.
function logEng(level: LogLevel, message: string, runId?: string): void {
  const entry: LogEntry = { ts: new Date().toISOString(), level, message, source: 'engagements' };
  if (runId) entry.runId = runId;
  pushLog(entry);
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
  const runId = randomUUID();
  const result = await executeJob(runId);
  recordRun(result, runId);
  return { ok: result.ok, message: result.message };
});

async function executeJob(runId: string): Promise<RunResult> {
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

  const configResult = loadAppConfig();
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
    log: (level, message) => logScheduler(level, message, runId),
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
  const text = readAppConfigRaw();
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
  const result = saveAppConfigRaw(rawText);
  if (!result.ok) return { ok: false, errors: result.errors };
  return { ok: true, formatted: result.formatted, message: 'Config saved' };
});

// --- Engagements tab ---

ipcMain.handle('engagements:fetch', async () => {
  if (!isSignedIn()) return { ok: false, error: 'Not signed in', records: [] };

  const configResult = loadAppConfig();
  if (!configResult.ok) return { ok: false, error: `Config invalid: ${configResult.errors.join('; ')}`, records: [] };

  const config = configResult.config;
  if (!config.engagementsView) return { ok: false, error: 'engagementsView not configured', records: [] };

  try {
    const meta = getMetadata()!;
    const client = createSalesforceClient({
      instanceUrl: meta.instanceUrl,
      apiVersion: config.apiVersion,
      getAccessToken: () => getAccessToken(),
      forceRefresh: () => forceRefresh(),
    });
    const { soql } = buildEngagementsSOQL(config, { currentUserId: meta.userId });
    logEng('info', `Fetching engagements — Query: ${soql}`);
    const result = await client.query(soql);
    logEng('info', `Fetched ${result.records.length} engagement(s).`);
    const callDurations = config.engagementsView!.callDurations ?? ['30s', '1m', '5m', '15m', '30m', '45m', '1h'];
    const cardDisplay = config.engagementsView!.cardDisplay ?? {};
    return { ok: true, records: result.records, callDurations, cardDisplay };
  } catch (err) {
    const msg = scrubTokens((err as Error).message ?? 'Unknown error');
    logEng('error', `Engagements fetch failed: ${msg}`);
    return { ok: false, error: msg, records: [] };
  }
});

// --- Engagement call timers ---

const callTimers = new Map<string, ReturnType<typeof setTimeout>>();

function parseDurationMs(d: string): number {
  const trimmed = d.trim();
  if (/^\d+s$/.test(trimmed)) return parseInt(trimmed) * 1000;
  if (/^\d+m$/.test(trimmed)) return parseInt(trimmed) * 60 * 1000;
  if (/^\d+h$/.test(trimmed)) return parseInt(trimmed) * 60 * 60 * 1000;
  return 60 * 60 * 1000; // fallback: 1h
}

function clearCallTimer(recordId: string): boolean {
  const t = callTimers.get(recordId);
  if (t !== undefined) {
    clearTimeout(t);
    callTimers.delete(recordId);
    return true;
  }
  return false;
}

function startCallTimer(recordId: string, durationMs: number, config: import('../shared').JobConfig): void {
  clearCallTimer(recordId);
  const timer = setTimeout(async () => {
    callTimers.delete(recordId);
    const endCallAction = config.engagementsView?.endCallAction;
    if (!endCallAction || !isSignedIn()) return;
    const runId = randomUUID();
    const durationLabel = `${Math.round(durationMs / 1000)}s`;
    logEng('info', `Auto-revert timer fired for record ${recordId} after ${durationLabel}.`, runId);
    try {
      const meta = getMetadata()!;
      const client = createSalesforceClient({
        instanceUrl: meta.instanceUrl,
        apiVersion: config.apiVersion,
        getAccessToken: () => getAccessToken(),
        forceRefresh: () => forceRefresh(),
      });
      const payload: Record<string, unknown> = { Id: recordId };
      for (const uf of endCallAction.updateFields) payload[uf.field] = uf.value;
      const fields = endCallAction.updateFields.map((f) => `${f.field}=${JSON.stringify(f.value)}`).join(', ');
      logEng('info', `Auto-reverting ${config.object} ${recordId}: ${fields}`, runId);
      await client.updateRecords(config.object, [payload as { Id: string; [k: string]: unknown }]);
      const statusField = config.engagementsView?.cardDisplay?.statusField ?? 'Engagement_Status__c';
      const newStatus = endCallAction.updateFields.find(f => f.field === statusField)?.value ?? '';
      logEng('success', `Auto-revert complete — status set to "${newStatus}" for ${recordId}.`, runId);
      mainWindow?.webContents.send('engagements:auto-end-call', { recordId, newStatus });
    } catch (err) {
      const msg = scrubTokens((err as Error).message ?? 'Unknown error');
      logEng('error', `Auto-revert failed for ${recordId}: ${msg}`, runId);
      console.error('[timer] auto end-call failed:', msg);
    }
  }, durationMs);
  callTimers.set(recordId, timer);
}

// --- Engagement card call actions ---

ipcMain.handle('engagements:call-action', async (_e, { recordId, actionType, duration }: { recordId: string; actionType: 'customer' | 'internal'; duration: string }) => {
  if (!isSignedIn()) return { ok: false, error: 'Not signed in' };

  const configResult = loadAppConfig();
  if (!configResult.ok) return { ok: false, error: `Config invalid: ${configResult.errors.join('; ')}` };

  const config = configResult.config;
  const ev = config.engagementsView;
  const action = actionType === 'customer' ? ev?.customerCallAction : ev?.internalCallAction;
  if (!action) return { ok: false, error: `${actionType}CallAction not configured` };

  const label = actionType === 'customer' ? 'External Call' : 'Internal Call';
  const runId = randomUUID();
  logEng('info', `${label} action on record ${recordId} (duration: ${duration})`, runId);

  try {
    const meta = getMetadata()!;
    const client = createSalesforceClient({
      instanceUrl: meta.instanceUrl,
      apiVersion: config.apiVersion,
      getAccessToken: () => getAccessToken(),
      forceRefresh: () => forceRefresh(),
    });

    // Step 1: patch the Engagement record
    const updatePayload: Record<string, unknown> = { Id: recordId };
    for (const uf of action.updateFields) updatePayload[uf.field] = uf.value;
    const fields = action.updateFields.map((f) => `${f.field}=${JSON.stringify(f.value)}`).join(', ');
    logEng('info', `Patching ${config.object} ${recordId}: ${fields}`, runId);
    await client.updateRecords(config.object, [updatePayload as { Id: string; [k: string]: unknown }]);
    logEng('success', `${config.object} ${recordId} updated successfully.`, runId);

    // Step 2: create each child record, substituting {recordId} (only if configured)
    if (action.createRecords && action.createRecords.length > 0) {
      for (const cr of action.createRecords) {
        const recFields: Record<string, unknown> = {};
        for (const f of cr.fields) {
          recFields[f.field] = f.value === '{recordId}' ? recordId : f.value;
        }
        logEng('info', `Creating ${cr.object} record for engagement ${recordId}.`, runId);
        await client.createRecord(cr.object, recFields);
        logEng('success', `${cr.object} record created.`, runId);
      }
    }

    // Step 3: start auto-revert timer
    startCallTimer(recordId, parseDurationMs(duration), config);
    logEng('info', `Auto-revert timer started — will revert status after ${duration}.`, runId);

    return { ok: true };
  } catch (err) {
    const msg = err instanceof SalesforceApiError
      ? `[${err.errorCode}] ${err.message}`
      : scrubTokens((err as Error).message ?? 'Unknown error');
    logEng('error', `${label} action failed: ${msg}`, runId);
    return { ok: false, error: msg };
  }
});

ipcMain.handle('engagements:open-record', async (_e, { recordId }: { recordId: string }) => {
  if (!isSignedIn()) return { ok: false, error: 'Not signed in' };
  const configResult = loadAppConfig();
  if (!configResult.ok) return { ok: false, error: 'Config invalid' };
  const meta = getMetadata()!;
  const url = `${meta.instanceUrl}/lightning/r/${configResult.config.object}/${recordId}/view`;
  await shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle('engagements:working-action', async (
  _e,
  { recordId, currentStatus }: { recordId: string; currentStatus: string }
) => {
  if (!isSignedIn()) return { ok: false, error: 'Not signed in' };
  const configResult = loadAppConfig();
  if (!configResult.ok) return { ok: false, error: `Config invalid: ${configResult.errors.join('; ')}` };
  const config = configResult.config;

  // Toggle: currently In Progress → revert via endCallAction; otherwise → set via workingAction.
  const isInProgress = currentStatus === 'In Progress';
  const ev = config.engagementsView;
  const action = isInProgress ? ev?.endCallAction : ev?.workingAction;
  const actionName = isInProgress ? 'endCallAction' : 'workingAction';
  if (!action) return { ok: false, error: `${actionName} not configured` };

  const direction = isInProgress ? 'In Progress → Waiting on Customer' : `${currentStatus} → In Progress`;
  const runId = randomUUID();
  logEng('info', `Working toggle on ${recordId}: ${direction}`, runId);

  try {
    const meta = getMetadata()!;
    const client = createSalesforceClient({
      instanceUrl: meta.instanceUrl,
      apiVersion: config.apiVersion,
      getAccessToken: () => getAccessToken(),
      forceRefresh: () => forceRefresh(),
    });
    const payload: Record<string, unknown> = { Id: recordId };
    for (const uf of action.updateFields) payload[uf.field] = uf.value;
    const fields = action.updateFields.map((f) => `${f.field}=${JSON.stringify(f.value)}`).join(', ');
    logEng('info', `Patching ${config.object} ${recordId}: ${fields}`, runId);
    await client.updateRecords(config.object, [payload as { Id: string; [k: string]: unknown }]);
    // Return the new status so the renderer can update in-memory without a refetch.
    const statusField = config.engagementsView?.cardDisplay?.statusField ?? 'Engagement_Status__c';
    const newStatus = action.updateFields.find(f => f.field === statusField)?.value ?? '';
    logEng('success', `Status updated to "${newStatus}".`, runId);
    return { ok: true, newStatus };
  } catch (err) {
    const msg = err instanceof SalesforceApiError
      ? `[${err.errorCode}] ${err.message}`
      : scrubTokens((err as Error).message ?? 'Unknown error');
    logEng('error', `Working toggle failed: ${msg}`, runId);
    return { ok: false, error: msg };
  }
});

ipcMain.handle('engagements:end-call', async (_e, { recordId }: { recordId: string }) => {
  if (!isSignedIn()) return { ok: false, error: 'Not signed in' };

  const configResult = loadAppConfig();
  if (!configResult.ok) return { ok: false, error: `Config invalid: ${configResult.errors.join('; ')}` };

  const config = configResult.config;
  const endCallAction = config.engagementsView?.endCallAction;
  if (!endCallAction) return { ok: false, error: 'endCallAction not configured' };

  // Cancel any running auto-revert timer for this record.
  const runId = randomUUID();
  const hadTimer = clearCallTimer(recordId);
  if (hadTimer) logEng('info', `Auto-revert timer cancelled for record ${recordId} (manual End Call).`, runId);
  logEng('info', `End call (manual) on record ${recordId}.`, runId);

  try {
    const meta = getMetadata()!;
    const client = createSalesforceClient({
      instanceUrl: meta.instanceUrl,
      apiVersion: config.apiVersion,
      getAccessToken: () => getAccessToken(),
      forceRefresh: () => forceRefresh(),
    });

    const updatePayload: Record<string, unknown> = { Id: recordId };
    for (const uf of endCallAction.updateFields) updatePayload[uf.field] = uf.value;
    const fields = endCallAction.updateFields.map((f) => `${f.field}=${JSON.stringify(f.value)}`).join(', ');
    logEng('info', `Patching ${config.object} ${recordId}: ${fields}`, runId);
    await client.updateRecords(config.object, [updatePayload as { Id: string; [k: string]: unknown }]);
    logEng('success', `End call completed — status reverted for ${recordId}.`, runId);

    return { ok: true };
  } catch (err) {
    const msg = err instanceof SalesforceApiError
      ? `[${err.errorCode}] ${err.message}`
      : scrubTokens((err as Error).message ?? 'Unknown error');
    logEng('error', `End call failed: ${msg}`, runId);
    return { ok: false, error: msg };
  }
});

// Clear timers for records that no longer have Call/Meeting Scheduled status (e.g. changed externally).
ipcMain.handle('engagements:clear-stale-timers', (_e, { scheduledIds }: { scheduledIds: string[] }) => {
  const scheduled = new Set(scheduledIds);
  for (const id of Array.from(callTimers.keys())) {
    if (!scheduled.has(id)) clearCallTimer(id);
  }
  return { ok: true };
});

// --- Paths (About tab) ---

ipcMain.handle('paths:get', () => {
  return {
    configPath: getAppConfigPath(),
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

  // Rename legacy job-config.json → app-config.json if needed.
  migrateConfigFilename();

  // Create sample config on very first run so there's something to sign in against.
  try {
    if (scaffoldSampleConfigIfMissing()) {
      console.log(`[config] Created sample config at ${getAppConfigPath()}`);
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
      const runId = randomUUID();
      const result = await executeJob(runId);
      recordRun(result, runId);
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

  // On macOS the dock icon stays visible at all times (standard app behavior).
  // On other platforms, hide the dock before creating the window if auto-launching.
  if (process.platform !== 'darwin' && !shouldShowWindow) {
    setDockVisible(false);
  }

  createWindow(shouldShowWindow);
  createTray();

  // On macOS, clicking the dock icon re-opens or focuses the window.
  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow(true);
    } else if (mainWindow.isMinimized()) {
      mainWindow.restore();
    } else if (!mainWindow.isVisible()) {
      mainWindow.show();
    } else {
      mainWindow.focus();
    }
  });
});

app.on('window-all-closed', () => { /* tray app — don't quit */ });
app.on('before-quit', () => {
  (app as any).isQuitting = true;
  scheduler?.stop();
});