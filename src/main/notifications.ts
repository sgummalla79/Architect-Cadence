// OS notifications for scheduled-run outcomes.
//
// Per spec:
//   - Only scheduled runs trigger notifications. Run Now is silent (the user
//     is already looking at the app).
//   - Both successes AND failures trigger notifications.
//   - "Inactive mode" (mode === 'select-only') is treated as a non-event —
//     the user toggled the schedule off themselves; no need to notify.
//   - Click on the notification focuses/shows the main window.
//
// Notes on permissions:
//   - On macOS, the OS automatically prompts for notification permission the
//     first time .show() is called. We don't need (or have) an API to request
//     it explicitly. If the user denies, future show() calls become no-ops
//     and that's fine — the run is still recorded in the log.
//   - On Windows 10/11, notifications work without an explicit prompt as long
//     as the app has an AppUserModelID (Electron sets this to the dev/exe
//     name automatically; once we ship a packaged app in Module 9, it'll be
//     more stable).

import { Notification, BrowserWindow } from 'electron';
import type { RunResult } from './job-runner';

export interface NotifyOptions {
  /** Function returning the main window so we can focus it on click. */
  getMainWindow: () => BrowserWindow | null;
}

/**
 * Notify the user about a completed scheduled run. Notifies on both success
 * and failure, but skips the Inactive case (the user knowingly toggled it off).
 */
export function notifyScheduledRun(result: RunResult, opts: NotifyOptions): void {
  // 'select-only' means the run was skipped because the app is Inactive. The
  // user toggled that themselves; don't pester them.
  if (result.mode === 'select-only') return;

  if (!Notification.isSupported()) {
    console.log('[notify] Notifications not supported on this platform — skipping');
    return;
  }

  const notification = new Notification({
    title: 'Architect Cadence',
    body: result.message,
    silent: false,
  });

  notification.on('click', () => {
    const win = opts.getMainWindow();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  notification.show();
  console.log(
    `[notify] Scheduled-run ${result.ok ? 'success' : 'failure'} notification shown: ${result.message}`
  );
}