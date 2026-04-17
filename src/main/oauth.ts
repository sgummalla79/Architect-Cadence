// Pure OAuth helpers — no I/O, no Electron, fully unit-testable.
//
// PKCE (RFC 7636) lets a public client (no client secret) safely complete the
// authorization code flow. We generate a high-entropy `verifier`, hash it to
// produce a `challenge`, send the challenge in the authorize request, and send
// the verifier in the token exchange. Salesforce verifies they match.

import { createHash, randomBytes } from 'crypto';

// ============ Types ============

export interface PkcePair {
  /** High-entropy random string. Sent in the token exchange step. */
  codeVerifier: string;
  /** SHA-256 hash of the verifier, base64url-encoded. Sent in the authorize step. */
  codeChallenge: string;
}

export interface AuthorizeUrlOptions {
  /** e.g. 'https://login.salesforce.com' or 'https://mycompany.my.salesforce.com' */
  loginUrl: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  /** CSRF token — random string, checked in the callback. */
  state: string;
  /** OAuth scopes. Defaults to ['refresh_token', 'api', 'web']. */
  scopes?: string[];
}

/** Parsed OAuth callback from Salesforce's redirect to our loopback server. */
export type CallbackParams =
  | { ok: true; code: string; state: string }
  | { ok: false; error: string; errorDescription?: string; state?: string };

/** Response from POST /services/oauth2/token. */
export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  instance_url: string;
  id: string; // URL to the identity endpoint
  token_type: string;
  issued_at: string;
  signature: string;
  scope?: string;
}

/** Response from the identity endpoint (/services/oauth2/userinfo or the `id` URL). */
export interface UserInfo {
  user_id: string;
  username: string;
  organization_id: string;
  display_name?: string;
  email?: string;
}

// ============ PKCE ============

/**
 * Generate a PKCE verifier + challenge pair.
 * - Verifier: 43-chars, URL-safe random (our implementation uses 43 for minimum spec-compliant length).
 * - Challenge: base64url(SHA-256(verifier)).
 */
export function generatePkcePair(): PkcePair {
  // 32 random bytes → ~43 chars base64url. Within spec: 43..128 chars.
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

/** Generate a random state token for CSRF protection. */
export function generateState(): string {
  return base64url(randomBytes(16));
}

function base64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ============ Authorize URL ============

/**
 * Build the URL the user's browser should open to start the OAuth flow.
 * This is where Salesforce prompts for login and consent.
 */
export function buildAuthorizeUrl(options: AuthorizeUrlOptions): string {
  const scopes = options.scopes ?? ['refresh_token', 'api', 'web'];

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    state: options.state,
    code_challenge: options.codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'login',
    scope: scopes.join(' '),
  });

  return `${trimTrailingSlash(options.loginUrl)}/services/oauth2/authorize?${params.toString()}`;
}

// ============ Callback parsing ============

/**
 * Parse the query string from the OAuth callback URL.
 * Salesforce sends either { code, state } on success or { error, error_description, state } on failure.
 * Also validates that the returned state matches what we originally sent (CSRF defense).
 */
export function parseCallback(rawUrl: string, expectedState: string): CallbackParams {
  let u: URL;
  try {
    // rawUrl may be relative (from http server req.url) — prepend a dummy origin.
    u = rawUrl.startsWith('http') ? new URL(rawUrl) : new URL(rawUrl, 'http://localhost');
  } catch {
    return { ok: false, error: 'invalid_callback', errorDescription: 'Could not parse callback URL.' };
  }

  const code = u.searchParams.get('code');
  const state = u.searchParams.get('state') ?? undefined;
  const error = u.searchParams.get('error');
  const errorDescription = u.searchParams.get('error_description') ?? undefined;

  if (error) {
    return { ok: false, error, errorDescription, state };
  }

  if (!code) {
    return { ok: false, error: 'missing_code', errorDescription: 'No authorization code in callback.', state };
  }

  if (state !== expectedState) {
    return {
      ok: false,
      error: 'state_mismatch',
      errorDescription: 'State returned by Salesforce does not match. Possible CSRF attack.',
      state,
    };
  }

  return { ok: true, code, state };
}

// ============ Token exchange request bodies ============

/** Body for POST /services/oauth2/token (auth code grant). */
export function buildTokenExchangeBody(params: {
  clientId: string;
  codeVerifier: string;
  code: string;
  redirectUri: string;
}): string {
  return new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: params.clientId,
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
  }).toString();
}

/** Body for POST /services/oauth2/token (refresh token grant). */
export function buildRefreshTokenBody(params: {
  clientId: string;
  refreshToken: string;
}): string {
  return new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: params.clientId,
    refresh_token: params.refreshToken,
  }).toString();
}

// ============ Helpers ============

export function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/** Normalize a domain into a full https:// URL. Accepts 'foo.my.salesforce.com' or 'https://foo.my.salesforce.com'. */
export function normalizeLoginUrl(domain: string): string {
  const trimmed = domain.trim().replace(/^https?:\/\//, '');
  return `https://${trimTrailingSlash(trimmed)}`;
}