// In-memory session state. Holds the current access token (NEVER persisted)
// and knows how to refresh it when it expires.
//
// Design note: we don't pre-emptively refresh on expiry. Instead, API callers
// call `getAccessToken()` which returns the cached token, and if an API call
// returns 401 they call `forceRefresh()` and retry once. This is simpler and
// more resilient than trying to guess token lifetimes ahead of time.

import { refreshAccessToken } from './oauth-flow';
import {
  SessionMetadata,
  loadSession,
  saveSession,
  updateSessionMetadata,
  deleteSession,
} from './token-store';

export interface ActiveSession {
  metadata: SessionMetadata;
  /** Present after first sign-in or first use of refresh. */
  accessToken: string;
}

interface InternalState {
  metadata: SessionMetadata;
  refreshToken: string;
  accessToken: string | null;
}

let state: InternalState | null = null;

// ============ Public API ============

/** Try to load a persisted session from disk. Call once on app startup. */
export function initSessionFromDisk(): boolean {
  const persisted = loadSession();
  if (!persisted) return false;
  state = {
    metadata: persisted.metadata,
    refreshToken: persisted.refreshToken,
    accessToken: null, // will be fetched on first API call via refresh
  };
  return true;
}

/** Install a brand new session (after a successful sign-in flow). */
export function installSession(params: {
  accessToken: string;
  refreshToken: string;
  metadata: SessionMetadata;
}): void {
  state = {
    metadata: params.metadata,
    refreshToken: params.refreshToken,
    accessToken: params.accessToken,
  };
  saveSession(params.refreshToken, params.metadata);
}

/** Clear the session (after Reset Connection). */
export function clearSession(): void {
  state = null;
  deleteSession();
}

/** True if we have a persisted refresh token we can use. */
export function isSignedIn(): boolean {
  return state !== null;
}

/** Public-safe view of the current session metadata, for the UI. */
export function getPublicSession(): SessionMetadata | null {
  return state?.metadata ?? null;
}

/**
 * Get a usable access token. If we haven't acquired one this session yet,
 * or if `force` is true, perform a refresh.
 */
export async function getAccessToken(force = false): Promise<string> {
  if (!state) {
    throw new Error('Not signed in — no refresh token available.');
  }
  if (state.accessToken && !force) {
    return state.accessToken;
  }
  await refreshInternal();
  return state.accessToken!;
}

/** For convenience when a call hits 401 and needs a retry. */
export async function forceRefresh(): Promise<string> {
  return getAccessToken(true);
}

/** Read-only access to the instance URL + user info. */
export function getMetadata(): SessionMetadata | null {
  return state?.metadata ?? null;
}

// ============ Internals ============

async function refreshInternal(): Promise<void> {
  if (!state) throw new Error('Not signed in.');

  const response = await refreshAccessToken({
    loginUrl: state.metadata.loginUrl,
    clientId: 'PlatformCLI',
    refreshToken: state.refreshToken,
  });

  state.accessToken = response.access_token;

  // The refresh can also update the instance URL in rare cases (e.g. org migration).
  if (response.instance_url && response.instance_url !== state.metadata.instanceUrl) {
    state.metadata.instanceUrl = response.instance_url;
  }
  state.metadata.lastRefreshedAt = new Date().toISOString();
  updateSessionMetadata(state.metadata);
}