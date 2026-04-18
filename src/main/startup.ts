// Launch-at-startup (login item) management.
//
// Uses Electron's built-in app.setLoginItemSettings(). Behavior by platform:
//   - macOS:  adds/removes the app from "Login Items" in System Settings.
//             wasOpenedAtLogin tells us if we were auto-started.
//   - Windows: adds/removes a Run key in the registry. Electron has no
//             wasOpenedAtLogin on Windows, so we register with a `--hidden`
//             argv flag and check for it at startup.
//   - Linux:  the Electron API is a no-op. We detect this and disable the
//             toggle in the UI rather than silently lying.

import { app } from 'electron';

/** The CLI flag we pass to the Windows login item so we can detect auto-launch. */
const AUTOLAUNCH_FLAG = '--autolaunched';

export interface StartupStatus {
  supported: boolean;
  enabled: boolean;
}

export function isStartupSupported(): boolean {
  return process.platform === 'darwin' || process.platform === 'win32';
}

export function getStartupStatus(): StartupStatus {
  if (!isStartupSupported()) {
    return { supported: false, enabled: false };
  }
  try {
    // On Windows, we must pass the same `args` we used when setting, so the
    // API can match our registry entry. On macOS, args is ignored.
    const settings =
      process.platform === 'win32'
        ? app.getLoginItemSettings({ args: [AUTOLAUNCH_FLAG] })
        : app.getLoginItemSettings();
    return { supported: true, enabled: settings.openAtLogin === true };
  } catch {
    return { supported: false, enabled: false };
  }
}

/**
 * Enable or disable launch-at-startup. Registers the app with a known argv
 * flag so we can detect auto-launch on all platforms.
 */
export function setStartupEnabled(enabled: boolean): StartupStatus {
  if (!isStartupSupported()) {
    return { supported: false, enabled: false };
  }
  try {
    if (process.platform === 'win32') {
      app.setLoginItemSettings({
        openAtLogin: enabled,
        args: [AUTOLAUNCH_FLAG],
      });
    } else {
      // macOS
      app.setLoginItemSettings({
        openAtLogin: enabled,
        openAsHidden: true, // ignored on macOS 13+, harmless
      });
    }
    return getStartupStatus();
  } catch (err) {
    console.error(`[startup] Could not set login item: ${(err as Error).message}`);
    return getStartupStatus();
  }
}

/**
 * True if this process was started automatically by the OS as part of login,
 * as opposed to being launched manually by the user.
 *
 * - macOS: uses app.getLoginItemSettings().wasOpenedAtLogin
 * - Windows: checks process.argv for the flag we register with
 * - Linux: always false (not supported)
 */
export function wasAutoLaunched(): boolean {
  if (process.platform === 'darwin') {
    try {
      return app.getLoginItemSettings().wasOpenedAtLogin === true;
    } catch {
      return false;
    }
  }
  if (process.platform === 'win32') {
    return process.argv.includes(AUTOLAUNCH_FLAG);
  }
  return false;
}