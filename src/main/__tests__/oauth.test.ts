import { createHash } from 'crypto';
import {
  buildAuthorizeUrl,
  buildRefreshTokenBody,
  buildTokenExchangeBody,
  generatePkcePair,
  generateState,
  normalizeLoginUrl,
  parseCallback,
  trimTrailingSlash,
} from '../oauth';

describe('generatePkcePair', () => {
  test('returns verifier and challenge', () => {
    const pair = generatePkcePair();
    expect(pair.codeVerifier).toBeTruthy();
    expect(pair.codeChallenge).toBeTruthy();
  });

  test('verifier is 43 chars (32 bytes base64url)', () => {
    const { codeVerifier } = generatePkcePair();
    expect(codeVerifier).toHaveLength(43);
  });

  test('verifier uses only URL-safe characters', () => {
    const { codeVerifier } = generatePkcePair();
    expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test('challenge is base64url(SHA-256(verifier))', () => {
    const { codeVerifier, codeChallenge } = generatePkcePair();
    const expected = createHash('sha256')
      .update(codeVerifier)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(codeChallenge).toBe(expected);
  });

  test('each call produces different values', () => {
    const a = generatePkcePair();
    const b = generatePkcePair();
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(a.codeChallenge).not.toBe(b.codeChallenge);
  });
});

describe('generateState', () => {
  test('produces a non-empty URL-safe string', () => {
    const s = generateState();
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(s.length).toBeGreaterThanOrEqual(22);
  });

  test('each call differs', () => {
    expect(generateState()).not.toBe(generateState());
  });
});

describe('buildAuthorizeUrl', () => {
  const base = {
    loginUrl: 'https://login.salesforce.com',
    clientId: 'PlatformCLI',
    redirectUri: 'http://localhost:1717/OauthRedirect',
    codeChallenge: 'ABC123',
    state: 'state-xyz',
  };

  test('includes all required OAuth params', () => {
    const url = new URL(buildAuthorizeUrl(base));
    expect(url.pathname).toBe('/services/oauth2/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('PlatformCLI');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:1717/OauthRedirect');
    expect(url.searchParams.get('state')).toBe('state-xyz');
    expect(url.searchParams.get('code_challenge')).toBe('ABC123');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('prompt')).toBe('login');
  });

  test('default scopes are refresh_token + api + web', () => {
    const url = new URL(buildAuthorizeUrl(base));
    expect(url.searchParams.get('scope')).toBe('refresh_token api web');
  });

  test('custom scopes can be provided', () => {
    const url = new URL(buildAuthorizeUrl({ ...base, scopes: ['refresh_token', 'full'] }));
    expect(url.searchParams.get('scope')).toBe('refresh_token full');
  });

  test('handles login URL with trailing slash', () => {
    const url = buildAuthorizeUrl({ ...base, loginUrl: 'https://login.salesforce.com/' });
    expect(url.startsWith('https://login.salesforce.com/services/oauth2/authorize?')).toBe(true);
  });

  test('works with My Domain login URLs', () => {
    const url = new URL(
      buildAuthorizeUrl({ ...base, loginUrl: 'https://foo.my.salesforce.com' })
    );
    expect(url.hostname).toBe('foo.my.salesforce.com');
  });
});

describe('parseCallback', () => {
  test('success case: code + matching state', () => {
    const result = parseCallback('/OauthRedirect?code=AC123&state=xyz', 'xyz');
    expect(result).toEqual({ ok: true, code: 'AC123', state: 'xyz' });
  });

  test('rejects state mismatch', () => {
    const result = parseCallback('/OauthRedirect?code=AC123&state=wrong', 'xyz');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('state_mismatch');
    }
  });

  test('forwards Salesforce error', () => {
    const result = parseCallback(
      '/OauthRedirect?error=access_denied&error_description=user+denied&state=xyz',
      'xyz'
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('access_denied');
      expect(result.errorDescription).toBe('user denied');
    }
  });

  test('handles missing code', () => {
    const result = parseCallback('/OauthRedirect?state=xyz', 'xyz');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('missing_code');
  });

  test('works with full URL too', () => {
    const result = parseCallback(
      'http://localhost:1717/OauthRedirect?code=X&state=Y',
      'Y'
    );
    expect(result.ok).toBe(true);
  });

  test('handles malformed URL', () => {
    const result = parseCallback('not a url at all !!!', 'Y');
    // It's parseable as a path by URL constructor with a base, so this still
    // parses — but no code/state present, so we expect missing_code or state_mismatch.
    expect(result.ok).toBe(false);
  });
});

describe('buildTokenExchangeBody', () => {
  test('has all required form fields', () => {
    const body = buildTokenExchangeBody({
      clientId: 'PlatformCLI',
      code: 'AC123',
      codeVerifier: 'verifier',
      redirectUri: 'http://localhost:1717/OauthRedirect',
    });
    const params = new URLSearchParams(body);
    expect(params.get('grant_type')).toBe('authorization_code');
    expect(params.get('client_id')).toBe('PlatformCLI');
    expect(params.get('code')).toBe('AC123');
    expect(params.get('redirect_uri')).toBe('http://localhost:1717/OauthRedirect');
    expect(params.get('code_verifier')).toBe('verifier');
  });
});

describe('buildRefreshTokenBody', () => {
  test('has all required form fields', () => {
    const body = buildRefreshTokenBody({
      clientId: 'PlatformCLI',
      refreshToken: 'RT!abc',
    });
    const params = new URLSearchParams(body);
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('client_id')).toBe('PlatformCLI');
    expect(params.get('refresh_token')).toBe('RT!abc');
  });
});

describe('trimTrailingSlash', () => {
  test('removes single trailing slash', () => {
    expect(trimTrailingSlash('https://a.com/')).toBe('https://a.com');
  });
  test('no-op when no trailing slash', () => {
    expect(trimTrailingSlash('https://a.com')).toBe('https://a.com');
  });
});

describe('normalizeLoginUrl', () => {
  test('bare domain gets https prepended', () => {
    expect(normalizeLoginUrl('foo.my.salesforce.com')).toBe('https://foo.my.salesforce.com');
  });
  test('already-qualified URL is preserved', () => {
    expect(normalizeLoginUrl('https://foo.my.salesforce.com')).toBe('https://foo.my.salesforce.com');
  });
  test('strips trailing slash', () => {
    expect(normalizeLoginUrl('https://foo.my.salesforce.com/')).toBe('https://foo.my.salesforce.com');
  });
  test('accepts http and upgrades to https', () => {
    expect(normalizeLoginUrl('http://foo.my.salesforce.com')).toBe('https://foo.my.salesforce.com');
  });
  test('trims whitespace', () => {
    expect(normalizeLoginUrl('  foo.my.salesforce.com  ')).toBe('https://foo.my.salesforce.com');
  });
});