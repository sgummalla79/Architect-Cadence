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
import { appendLog, getLogPath, LogEntry, LogWindow, readLogs } from './log-store';
import { randomUUID } from 'crypto';
import { validateConfig } from '../shared';
import { loadPrefs, savePrefs, isValidTime } from './prefs-store';
import { createScheduler, Scheduler } from './scheduler';

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

// ============ Window / Tray ============

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 720,
    height: 760,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    frame: true,
    backgroundColor: '#0f1419',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.on('close', (e) => {
    if (!(app as any).isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
    mainWindow.show();
  }
}

function createTray(): void {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('Architect Cadence');
  updateTrayMenu();

  tray.on('click', () => {
    if (mainWindow?.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow?.show();
      mainWindow?.focus();
    }
  });
}

function updateTrayMenu(): void {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: 'Show Window', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    {
      label: 'Run Now',
      enabled: state.isConnected,
      click: () => mainWindow?.webContents.send('tray:run-now'),
    },
    {
      label: state.isActive ? 'Disable Schedule' : 'Enable Schedule',
      click: () => {
        state.isActive = !state.isActive;
        savePrefs({ isActive: state.isActive, scheduledTime: state.scheduledTime });
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
  savePrefs({ isActive: state.isActive, scheduledTime: state.scheduledTime });
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
  savePrefs({ isActive: state.isActive, scheduledTime: state.scheduledTime });
  console.log(`[ipc] Prefs saved: time=${time}, active=${state.isActive}`);
  scheduler?.reconfigure({ scheduledTime: state.scheduledTime, active: state.isActive });
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

// ============ Lifecycle ============

app.whenReady().then(() => {
  // Load user prefs (Active toggle + scheduled time) before the window opens
  // so the UI paints the correct state immediately.
  try {
    const prefs = loadPrefs();
    state.isActive = prefs.isActive;
    state.scheduledTime = prefs.scheduledTime;
    console.log(`[prefs] Loaded: active=${state.isActive}, time=${state.scheduledTime}`);
  } catch (err) {
    console.error(`[prefs] Could not load: ${(err as Error).message}`);
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

  // Start the scheduler. onTick runs the same job pipeline as Run Now.
  scheduler = createScheduler({
    scheduledTime: state.scheduledTime,
    active: state.isActive,
    onTick: async () => {
      console.log(`[scheduler] Tick at ${new Date().toISOString()}`);
      const result = await executeJob();
      recordRun(result);
    },
  });
  console.log(
    `[scheduler] Configured for ${state.scheduledTime} local time (${state.isActive ? 'enabled' : 'paused'})`
  );

  createWindow();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow?.show();
  });
});

app.on('window-all-closed', () => { /* tray app — don't quit */ });
app.on('before-quit', () => {
  (app as any).isQuitting = true;
  scheduler?.stop();
});