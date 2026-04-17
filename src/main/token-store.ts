// Persistent storage for the OAuth session.
//
// Security model:
//   - Refresh token is encrypted using Electron's `safeStorage` (backed by
//     macOS Keychain / Windows DPAPI / Linux libsecret) and written to disk
//     as an encrypted blob at `<userData>/session.enc`.
//   - Non-secret metadata (username, instance URL, user Id, org Id) is stored
//     as plain JSON at `<userData>/session.json` so we can show "Connected as X"
//     immediately on app start without having to unlock the keychain.
//
// Access tokens are NEVER persisted. They live only in memory (see session.ts)
// and are re-acquired via the refresh token on every app start.

import { app, safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

export interface SessionMetadata {
  /** Salesforce user Id (e.g. '005XXXXXXXXXXXX'). */
  userId: string;
  /** Salesforce username (e.g. 'jdoe@example.com'). */
  username: string;
  /** Instance URL for API calls (e.g. 'https://foo.my.salesforce.com'). */
  instanceUrl: string;
  /** Login URL used to authenticate (e.g. 'https://login.salesforce.com'). */
  loginUrl: string;
  /** Organization Id. */
  organizationId: string;
  /** ISO timestamp of when the session was last refreshed. */
  lastRefreshedAt: string;
}

const META_FILENAME = 'session.json';
const TOKEN_FILENAME = 'session.enc';

// ============ Public API ============

/** Persist a new session (refresh token + metadata). Overwrites any existing session. */
export function saveSession(refreshToken: string, metadata: SessionMetadata): void {
  assertSafeStorageAvailable();
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });

  const encrypted = safeStorage.encryptString(refreshToken);
  fs.writeFileSync(path.join(dir, TOKEN_FILENAME), encrypted);
  fs.writeFileSync(
    path.join(dir, META_FILENAME),
    JSON.stringify(metadata, null, 2),
    'utf8'
  );
}

/** Load the persisted session if one exists, else null. */
export function loadSession(): { refreshToken: string; metadata: SessionMetadata } | null {
  const dir = app.getPath('userData');
  const tokenPath = path.join(dir, TOKEN_FILENAME);
  const metaPath = path.join(dir, META_FILENAME);

  if (!fs.existsSync(tokenPath) || !fs.existsSync(metaPath)) {
    return null;
  }

  assertSafeStorageAvailable();

  let metadata: SessionMetadata;
  try {
    metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as SessionMetadata;
  } catch {
    // Corrupt metadata — wipe the session to force a fresh sign-in.
    deleteSession();
    return null;
  }

  let refreshToken: string;
  try {
    refreshToken = safeStorage.decryptString(fs.readFileSync(tokenPath));
  } catch {
    // Can happen if the user migrated OS keychains, re-imaged their machine, etc.
    deleteSession();
    return null;
  }

  return { refreshToken, metadata };
}

/** Update the metadata (e.g. after a token refresh updates lastRefreshedAt). */
export function updateSessionMetadata(metadata: SessionMetadata): void {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, META_FILENAME),
    JSON.stringify(metadata, null, 2),
    'utf8'
  );
}

/** Delete all session data (used by the Reset Connection button). */
export function deleteSession(): void {
  const dir = app.getPath('userData');
  for (const name of [META_FILENAME, TOKEN_FILENAME]) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

/** For display/diagnostic purposes. */
export function getSessionPaths(): { metadata: string; encrypted: string } {
  const dir = app.getPath('userData');
  return {
    metadata: path.join(dir, META_FILENAME),
    encrypted: path.join(dir, TOKEN_FILENAME),
  };
}

// ============ Internals ============

function assertSafeStorageAvailable(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'Secure storage is not available on this system. On Linux, install a keyring backend (gnome-keyring or kwallet). On Mac/Windows this should never fail.'
    );
  }
}