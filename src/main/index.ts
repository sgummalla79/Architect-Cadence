import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, shell } from 'electron';
import * as path from 'path';
import {
  getJobConfigPath,
  loadJobConfig,
  openConfigInEditor,
  resolveLoginUrl,
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

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

const state = {
  isActive: true,
  isConnected: false,
  scheduledTime: '15:22',
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
    minWidth: 640,
    minHeight: 560,
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
        updateTrayMenu();
        mainWindow?.webContents.send('state:changed', state);
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => { (app as any).isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

// Push a completed run result to the renderer's log panel.
function pushRunToUi(result: RunResult): void {
  if (!mainWindow) return;
  const level = result.ok ? 'success' : 'error';
  const prefix = result.ok ? '✓' : '✗';
  mainWindow.webContents.send('log:append', {
    ts: new Date().toLocaleString('sv-SE').replace('T', ' '),
    level,
    message: `${prefix} ${result.message} (${result.durationMs}ms)`,
  });
}

// ============ IPC ============

ipcMain.handle('state:get', () => state);

ipcMain.handle('state:set-active', (_e, isActive: boolean) => {
  state.isActive = isActive;
  updateTrayMenu();
  return state;
});

ipcMain.handle('state:set-time', (_e, time: string) => {
  state.scheduledTime = time;
  return state;
});

// --- Module 4: real Run Now ---

ipcMain.handle('action:run-now', async () => {
  const result = await executeJob();
  pushRunToUi(result);
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

// --- Config ---

ipcMain.handle('action:edit-config', async () => {
  try {
    await openConfigInEditor();
    return { ok: true, message: `Opened ${getJobConfigPath()}` };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
});

ipcMain.handle('action:validate-config', () => {
  const result = loadJobConfig();
  if (result.ok) {
    return { ok: true, message: `Config valid — object: ${result.config.object}` };
  }
  return { ok: false, message: result.errors.join('; ') };
});

ipcMain.handle('action:clear-logs', () => {
  // UI-only per spec; nothing to do in main.
  return { ok: true };
});

// ============ Lifecycle ============

app.whenReady().then(() => {
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

  createWindow();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow?.show();
  });
});

app.on('window-all-closed', () => { /* tray app — don't quit */ });
app.on('before-quit', () => { (app as any).isQuitting = true; });