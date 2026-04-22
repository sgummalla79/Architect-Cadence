// OAuth flow orchestrator.
// Owns the loopback HTTP server that catches the Salesforce redirect, and
// performs the HTTPS POST to exchange the auth code for tokens.
//
// Kept separate from `oauth.ts` so the pure helpers there are unit-testable
// without spinning up servers or mocking `https`.

import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { request as httpsRequest } from 'https';
import {
  AuthorizeUrlOptions,
  buildAuthorizeUrl,
  buildRefreshTokenBody,
  buildTokenExchangeBody,
  CallbackParams,
  generatePkcePair,
  generateState,
  parseCallback,
  TokenResponse,
  trimTrailingSlash,
  UserInfo,
} from './oauth';

// ============ Constants ============

/** Matches SFDX CLI's redirect URI, so the domain's Connected App (PlatformCLI) accepts it. */
export const DEFAULT_REDIRECT_PORT = 1717;
export const DEFAULT_REDIRECT_PATH = '/OauthRedirect';
export const DEFAULT_CLIENT_ID = 'PlatformCLI';

/** Max time we'll wait for the user to complete the browser flow. */
export const DEFAULT_FLOW_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ============ Types ============

export interface OAuthFlowOptions {
  loginUrl: string;
  clientId?: string;
  redirectPort?: number;
  redirectPath?: string;
  scopes?: string[];
  timeoutMs?: number;
  /** Called with the authorize URL so the caller can open it in the browser. */
  openBrowser: (url: string) => void;
}

export interface OAuthFlowResult {
  tokens: TokenResponse;
  userInfo: UserInfo;
}

// ============ Browser flow ============

/**
 * Run the full interactive OAuth flow:
 *  1. Start loopback server
 *  2. Open browser to authorize URL (via the caller's `openBrowser`)
 *  3. Wait for callback
 *  4. Exchange code for tokens
 *  5. Fetch user info
 *
 * Resolves with tokens + user info on success.
 * Rejects with a descriptive Error on any failure (including timeout).
 */
export async function performOAuthFlow(options: OAuthFlowOptions): Promise<OAuthFlowResult> {
  const clientId = options.clientId ?? DEFAULT_CLIENT_ID;
  const port = options.redirectPort ?? DEFAULT_REDIRECT_PORT;
  const path = options.redirectPath ?? DEFAULT_REDIRECT_PATH;
  const redirectUri = `http://localhost:${port}${path}`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_FLOW_TIMEOUT_MS;

  const pkce = generatePkcePair();
  const state = generateState();

  const authorizeOptions: AuthorizeUrlOptions = {
    loginUrl: options.loginUrl,
    clientId,
    redirectUri,
    codeChallenge: pkce.codeChallenge,
    state,
    scopes: options.scopes,
  };
  const authorizeUrl = buildAuthorizeUrl(authorizeOptions);

  // Catch callback via loopback server
  const callback = await catchCallback({
    port,
    path,
    expectedState: state,
    timeoutMs,
    openBrowser: () => options.openBrowser(authorizeUrl),
  });

  if (!callback.ok) {
    const suffix = callback.errorDescription ? `: ${callback.errorDescription}` : '';
    throw new Error(`Authorization failed (${callback.error})${suffix}`);
  }

  // Exchange code for tokens
  const tokens = await exchangeCodeForTokens({
    loginUrl: options.loginUrl,
    clientId,
    code: callback.code,
    codeVerifier: pkce.codeVerifier,
    redirectUri,
  });

  // Fetch user info (identity endpoint)
  const userInfo = await fetchUserInfo(tokens);

  return { tokens, userInfo };
}

// ============ Loopback server ============

interface CatchCallbackOptions {
  port: number;
  path: string;
  expectedState: string;
  timeoutMs: number;
  openBrowser: () => void;
}

function catchCallback(opts: CatchCallbackOptions): Promise<CallbackParams> {
  return new Promise((resolve, reject) => {
    let server: Server | null = null;
    let timeoutHandle: NodeJS.Timeout | null = null;

    const cleanup = (): void => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (server) server.close();
    };

    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      // Ignore favicon and anything else that's not our redirect path.
      if (!req.url || !req.url.startsWith(opts.path)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }

      const parsed = parseCallback(req.url, opts.expectedState);

      // Respond to the browser with a friendly page.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderCallbackPage(parsed));

      cleanup();
      resolve(parsed);
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      cleanup();
      if (err.code === 'EADDRINUSE') {
        reject(
          new Error(
            `Port ${opts.port} is already in use. If SFDX is currently running an auth flow, close it and try again.`
          )
        );
      } else {
        reject(err);
      }
    });

    server.listen(opts.port, '127.0.0.1', () => {
      // Set timeout once we know we're listening.
      timeoutHandle = setTimeout(() => {
        cleanup();
        reject(new Error('Sign-in timed out. The browser flow did not complete within 5 minutes.'));
      }, opts.timeoutMs);

      // Let the caller open the browser.
      try {
        opts.openBrowser();
      } catch (err) {
        cleanup();
        reject(err);
      }
    });
  });
}

function renderCallbackPage(result: CallbackParams): string {
  const title = result.ok ? 'Signed in successfully' : 'Sign-in failed';
  const message = result.ok
    ? 'You can close this tab and return to Architect Companion.'
    : `Error: ${escapeHtml(result.error)}${result.errorDescription ? ' — ' + escapeHtml(result.errorDescription) : ''}`;
  const accent = result.ok ? '#3fb950' : '#f85149';
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  body{background:#0f1419;color:#e6edf3;font-family:-apple-system,system-ui,sans-serif;
       display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
  .card{background:#161b22;border:1px solid #262d38;border-radius:10px;padding:32px 40px;max-width:420px;text-align:center}
  h1{margin:0 0 8px;font-size:20px;color:${accent}}
  p{margin:0;color:#7d8590;line-height:1.5}
</style></head>
<body><div class="card"><h1>${escapeHtml(title)}</h1><p>${message}</p></div></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)
  );
}

// ============ Token exchange ============

interface ExchangeCodeOptions {
  loginUrl: string;
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

export async function exchangeCodeForTokens(opts: ExchangeCodeOptions): Promise<TokenResponse> {
  const body = buildTokenExchangeBody({
    clientId: opts.clientId,
    code: opts.code,
    codeVerifier: opts.codeVerifier,
    redirectUri: opts.redirectUri,
  });

  const response = await postForm(`${trimTrailingSlash(opts.loginUrl)}/services/oauth2/token`, body);

  if (response.statusCode !== 200) {
    const err = parseErrorResponse(response.body);
    throw new Error(`Token exchange failed (${err.error}): ${err.errorDescription ?? response.body}`);
  }

  return JSON.parse(response.body) as TokenResponse;
}

interface RefreshTokensOptions {
  loginUrl: string;
  clientId: string;
  refreshToken: string;
}

/**
 * Exchange a refresh token for a new access token. Called when the access
 * token has expired (caller typically detects this via a 401 on an API call).
 */
export async function refreshAccessToken(opts: RefreshTokensOptions): Promise<TokenResponse> {
  const body = buildRefreshTokenBody({ clientId: opts.clientId, refreshToken: opts.refreshToken });
  const response = await postForm(`${trimTrailingSlash(opts.loginUrl)}/services/oauth2/token`, body);

  if (response.statusCode !== 200) {
    const err = parseErrorResponse(response.body);
    throw new Error(`Token refresh failed (${err.error}): ${err.errorDescription ?? response.body}`);
  }

  // Refresh responses don't include a new refresh_token (the old one stays valid).
  return JSON.parse(response.body) as TokenResponse;
}

function parseErrorResponse(body: string): { error: string; errorDescription?: string } {
  try {
    const obj = JSON.parse(body) as { error?: string; error_description?: string };
    return { error: obj.error ?? 'unknown', errorDescription: obj.error_description };
  } catch {
    return { error: 'non_json_response' };
  }
}

// ============ User info ============

async function fetchUserInfo(tokens: TokenResponse): Promise<UserInfo> {
  // The `id` field in the token response is the identity endpoint URL.
  const response = await getJson(tokens.id, { Authorization: `Bearer ${tokens.access_token}` });
  if (response.statusCode !== 200) {
    throw new Error(`Could not fetch user info (HTTP ${response.statusCode}): ${response.body}`);
  }
  const parsed = JSON.parse(response.body) as Record<string, string>;
  return {
    user_id: parsed.user_id,
    username: parsed.username,
    organization_id: parsed.organization_id,
    display_name: parsed.display_name,
    email: parsed.email,
  };
}

// ============ Minimal HTTPS client ============
// We don't pull in `fetch` or `axios` — Node's built-in https is enough for 3 calls.

interface HttpResponse {
  statusCode: number;
  body: string;
}

function postForm(url: string, body: string): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = httpsRequest(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body).toString(),
          Accept: 'application/json',
        },
      },
      (res) => collectResponse(res, resolve)
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function getJson(url: string, headers: Record<string, string>): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = httpsRequest(
      {
        method: 'GET',
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        headers: { ...headers, Accept: 'application/json' },
      },
      (res) => collectResponse(res, resolve)
    );
    req.on('error', reject);
    req.end();
  });
}

function collectResponse(res: IncomingMessage, resolve: (r: HttpResponse) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => {
    resolve({
      statusCode: res.statusCode ?? 0,
      body: Buffer.concat(chunks).toString('utf8'),
    });
  });
}