// Persistent preferences for non-secret app state (Active toggle, scheduled time).
//
// Tiny JSON file at <userData>/prefs.json. We don't use electron-store because:
//   - We only need 2 keys
//   - Vanilla fs is one less dependency
//   - Atomic-ish enough for our scale (write-replace; failure leaves last value intact)

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { isValidTime } from './prefs-validators';

export { isValidTime };

export interface Prefs {
  /** Whether scheduled runs should fire. Default: true. */
  isActive: boolean;
  /** Time of day for the scheduled run, "HH:MM" 24-hour, local time. Default: "23:00". */
  scheduledTime: string;
}

const PREFS_FILENAME = 'prefs.json';

const DEFAULTS: Prefs = {
  isActive: true,
  scheduledTime: '23:00',
};

function getPrefsPath(): string {
  return path.join(app.getPath('userData'), PREFS_FILENAME);
}

/** Load prefs from disk, falling back to defaults for missing/invalid values. */
export function loadPrefs(): Prefs {
  const p = getPrefsPath();
  if (!fs.existsSync(p)) return { ...DEFAULTS };

  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    return { ...DEFAULTS };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULTS };
  }

  const obj = parsed as Partial<Prefs>;
  return {
    isActive: typeof obj.isActive === 'boolean' ? obj.isActive : DEFAULTS.isActive,
    scheduledTime: isValidTime(obj.scheduledTime) ? obj.scheduledTime! : DEFAULTS.scheduledTime,
  };
}

/** Save prefs to disk. */
export function savePrefs(prefs: Prefs): void {
  const p = getPrefsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(prefs, null, 2) + '\n', 'utf8');
}