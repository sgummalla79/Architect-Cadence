// Standalone OAuth test script.
//
// Runs the full interactive OAuth flow OUTSIDE Electron so you can verify it
// works against your real Salesforce org before wiring it into the app.
//
// Usage:
//   npx tsx scripts/test-oauth.ts                  # defaults to login.salesforce.com
//   npx tsx scripts/test-oauth.ts --login https://foo.my.salesforce.com
//
// On success it prints the tokens and a sample userinfo response. Tokens are
// ONLY printed to the terminal — nothing is written to disk.
//
// NOTE: We can't import `./src/main/oauth-flow.ts` directly because that module
// is written for an Electron context (though it happens to work without Electron
// because it only uses Node built-ins). We import from the source file directly.

import { exec } from 'child_process';
import { platform } from 'os';
import { performOAuthFlow } from '../src/main/oauth-flow';

function openBrowser(url: string): void {
  const cmd =
    platform() === 'darwin'
      ? `open "${url}"`
      : platform() === 'win32'
      ? `start "" "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) {
      console.error('Could not auto-open browser. Open this URL manually:');
      console.error(url);
    }
  });
}

function parseArgs(): { loginUrl: string } {
  const args = process.argv.slice(2);
  let loginUrl = 'https://login.salesforce.com';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--login' && args[i + 1]) {
      loginUrl = args[i + 1];
      i++;
    }
  }
  return { loginUrl };
}

async function main(): Promise<void> {
  const { loginUrl } = parseArgs();

  console.log(`🔐 Starting OAuth flow`);
  console.log(`   Login URL:   ${loginUrl}`);
  console.log(`   Client ID:   PlatformCLI`);
  console.log(`   Redirect:    http://localhost:1717/OauthRedirect`);
  console.log(`   Scopes:      refresh_token api web`);
  console.log();
  console.log(`📖 Browser should open shortly. Complete the Salesforce login…`);
  console.log();

  try {
    const result = await performOAuthFlow({
      loginUrl,
      openBrowser,
    });

    console.log('✅ Sign-in successful\n');
    console.log('=== User info ===');
    console.log(`  Username:       ${result.userInfo.username}`);
    console.log(`  User Id:        ${result.userInfo.user_id}`);
    console.log(`  Org Id:         ${result.userInfo.organization_id}`);
    if (result.userInfo.display_name) {
      console.log(`  Display name:   ${result.userInfo.display_name}`);
    }
    console.log();

    console.log('=== Tokens ===');
    console.log(`  Instance URL:   ${result.tokens.instance_url}`);
    console.log(`  Token type:     ${result.tokens.token_type}`);
    console.log(`  Scope:          ${result.tokens.scope ?? '(not returned)'}`);
    console.log(`  Access token:   ${maskToken(result.tokens.access_token)}`);
    console.log(`  Refresh token:  ${result.tokens.refresh_token ? maskToken(result.tokens.refresh_token) : '(NOT RETURNED — refresh_token scope missing?)'}`);
    console.log();

    // Try a refresh as an additional sanity check
    if (result.tokens.refresh_token) {
      console.log('🔄 Testing refresh token…');
      const { refreshAccessToken } = await import('../src/main/oauth-flow');
      const refreshed = await refreshAccessToken({
        loginUrl,
        clientId: 'PlatformCLI',
        refreshToken: result.tokens.refresh_token,
      });
      console.log(`   New access token: ${maskToken(refreshed.access_token)}`);
      console.log(`   ✅ Refresh works`);
    }

    process.exit(0);
  } catch (err) {
    console.error(`❌ ${(err as Error).message}`);
    process.exit(1);
  }
}

function maskToken(token: string): string {
  if (token.length <= 12) return '***';
  return `${token.slice(0, 6)}…${token.slice(-4)} (${token.length} chars)`;
}

void main();