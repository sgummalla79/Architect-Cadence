// Pure validators used by prefs-store. Kept separate so tests don't need Electron.

export function isValidTime(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  // Accept HH:MM or HH:MM:SS — Chromium's <input type="time"> can emit either
  // depending on step= attribute and platform.
  return /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.test(s);
}