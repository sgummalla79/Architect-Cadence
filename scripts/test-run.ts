// Standalone job-runner test script.
//
// Runs the full SELECT + guardrail + (optional) UPDATE flow against your real
// Salesforce org, OUTSIDE Electron. Lets you verify job configuration and
// behavior before trusting the scheduled runs.
//
// SAFETY: defaults to DRY RUN (SELECT only, never writes). Pass --update to
// actually modify records. Defaults to Inactive mode — same safety model as
// the app when the toggle is off.
//
// Usage:
//   # Dry run (SELECT only, guardrail check, no writes):
//   npx tsx scripts/test-run.ts
//
//   # Use a specific config file instead of the default:
//   npx tsx scripts/test-run.ts --config ./my-config.json
//
//   # Actually perform the UPDATE (simulates "Active" mode):
//   npx tsx scripts/test-run.ts --update
//
// Reads the refresh token from the standard Electron userData path. If you
// haven't signed in via the app at least once, run `npm run test:oauth` first
// and then re-run this script. (This script reuses the session written by
// the Electron app — if no session exists, it exits with instructions.)

import { exec } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { performOAuthFlow, refreshAccessToken } from '../src/main/oauth-flow';
import { buildSoql, JobConfig, loadConfig } from '../src/shared';
import { createSalesforceClient } from '../src/main/salesforce-client';
import { runJob } from '../src/main/job-runner';
import { normalizeLoginUrl } from '../src/main/oauth';

// Sample config written to disk when the user runs test-run without one.
// Matches the spec example. Must be edited before it'll produce useful results.
const SAMPLE_CONFIG: JobConfig = {
  domain: 'exp-cloud.my.salesforce.com',
  apiVersion: 'v66.0',
  logLevel: 'info',
  object: 'Student__c',
  filters: {
    conditions: [
      { field: 'Final_Result__c', operator: '=', value: 'Withdrawn' },
      { field: 'Id', operator: 'IN', value: ['a0uKd00000L6xfQIAR'] },
    ],
    logic: '1 AND 2',
  },
  ownerFieldName: 'OwnerId',
  updateFields: [{ field: 'Final_Result__c', value: 'Distinction' }],
  maxRecords: 15,
};

// ============ CLI arg parsing ============

interface Args {
  configPath: string | null;
  doUpdate: boolean;
  loginUrl: string | null;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let configPath: string | null = null;
  let doUpdate = false;
  let loginUrl: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && args[i + 1]) {
      configPath = args[++i];
    } else if (args[i] === '--update') {
      doUpdate = true;
    } else if (args[i] === '--login' && args[i + 1]) {
      loginUrl = args[++i];
    } else if (args[i] === '--help' || args[i] === '-h') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${args[i]}`);
      printHelp();
      process.exit(1);
    }
  }
  return { configPath, doUpdate, loginUrl };
}

function printHelp(): void {
  console.log(`
Usage: tsx scripts/test-run.ts [options]

Options:
  --config <path>   Path to job-config.json (default: ~/Library/Application Support/architect-cadence/job-config.json on Mac)
  --update          Actually execute the UPDATE (omit for dry-run / SELECT only)
  --login <url>     Override login URL (default: read from config's domain, else login.salesforce.com)
  --help, -h        Show this help

Examples:
  tsx scripts/test-run.ts
  tsx scripts/test-run.ts --config ./test-config.json
  tsx scripts/test-run.ts --update
`);
}

// ============ Helpers ============

function defaultConfigPath(): string {
  // Mirrors Electron's app.getPath('userData') default. We can't call that
  // here (no Electron), so replicate the platform convention.
  const homedir = os.homedir();
  switch (process.platform) {
    case 'darwin':
      return path.join(homedir, 'Library', 'Application Support', 'architect-cadence', 'job-config.json');
    case 'win32':
      return path.join(
        process.env.APPDATA ?? path.join(homedir, 'AppData', 'Roaming'),
        'architect-cadence',
        'job-config.json'
      );
    default:
      return path.join(
        process.env.XDG_CONFIG_HOME ?? path.join(homedir, '.config'),
        'architect-cadence',
        'job-config.json'
      );
  }
}

function defaultUserDataDir(): string {
  return path.dirname(defaultConfigPath());
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin'
      ? `open "${url}"`
      : process.platform === 'win32'
      ? `start "" "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) {
      console.error('Could not auto-open browser. Open this URL manually:');
      console.error(url);
    }
  });
}

function maskToken(token: string): string {
  if (!token || token.length < 12) return '***';
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

// ============ Session reading ============
//
// The Electron app stores the refresh token encrypted via safeStorage and
// non-secret metadata in plain JSON. Without Electron, we can't decrypt the
// refresh token. So for this script:
//   - If no stored session, prompt for fresh interactive sign-in
//   - If stored session exists (plain metadata only — we can't read the encrypted token),
//     we still have to do fresh sign-in. Print a note about this.

async function obtainTokensAndUserId(
  loginUrl: string
): Promise<{ accessToken: string; refreshToken: string; userId: string; instanceUrl: string; username: string }> {
  const metaPath = path.join(defaultUserDataDir(), 'session.json');
  const hasMetaOnly = fs.existsSync(metaPath);

  if (hasMetaOnly) {
    console.log(
      `ℹ️  Found a prior Electron session at ${metaPath}, but this standalone script` +
        ` can't decrypt the refresh token (Electron's safeStorage). Performing a fresh sign-in.`
    );
    console.log();
  }

  console.log(`🔐 Starting OAuth flow against ${loginUrl}…`);
  const result = await performOAuthFlow({ loginUrl, openBrowser });
  if (!result.tokens.refresh_token) {
    throw new Error('No refresh token returned. Check Connected App scopes.');
  }
  return {
    accessToken: result.tokens.access_token,
    refreshToken: result.tokens.refresh_token,
    userId: result.userInfo.user_id,
    instanceUrl: result.tokens.instance_url,
    username: result.userInfo.username,
  };
}

// ============ Main ============

async function main(): Promise<void> {
  const args = parseArgs();
  const configPath = args.configPath ?? defaultConfigPath();

  console.log('='.repeat(72));
  console.log(`  Architect Cadence — test-run`);
  console.log(`  Config:     ${configPath}`);
  console.log(`  Mode:       ${args.doUpdate ? '🟢 ACTIVE (will execute UPDATE)' : '🟡 DRY RUN (SELECT only)'}`);
  console.log('='.repeat(72));
  console.log();

  // Step 1: load + validate config.
  if (!fs.existsSync(configPath)) {
    console.log(`⚠️  Config file not found at ${configPath}`);
    console.log(`   Creating a sample config for you. Edit it and re-run.`);
    console.log();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(SAMPLE_CONFIG, null, 2), 'utf8');
    console.log(`✅ Sample config written to ${configPath}`);
    console.log();
    console.log(`   Open that file in an editor and update at minimum:`);
    console.log(`     - domain          → your Salesforce My Domain (e.g. exp-cloud.my.salesforce.com)`);
    console.log(`     - object          → the sObject to query/update`);
    console.log(`     - filters         → the SELECT conditions`);
    console.log(`     - updateFields    → the field(s) to update`);
    console.log(`     - maxRecords      → the guardrail ceiling`);
    console.log();
    console.log(`   Then re-run: npm run test:run`);
    process.exit(0);
  }
  const configResult = loadConfig(configPath);
  if (!configResult.ok) {
    console.error('❌ Config validation failed:');
    for (const e of configResult.errors) console.error('   - ' + e);
    process.exit(1);
  }
  const config = configResult.config;
  console.log(`✅ Config is valid`);
  console.log(`   Object:        ${config.object}`);
  console.log(`   Filters:       ${config.filters.conditions.length} condition(s), logic: "${config.filters.logic}"`);
  console.log(`   Owner field:   ${config.ownerFieldName}`);
  console.log(`   Max records:   ${config.maxRecords}`);
  console.log(`   Update fields: ${config.updateFields.map((f) => `${f.field}=${JSON.stringify(f.value)}`).join(', ')}`);
  console.log();

  // Step 2: figure out login URL.
  const loginUrl = args.loginUrl ?? normalizeLoginUrl(config.domain);

  // Step 3: obtain tokens (fresh sign-in).
  const { accessToken, refreshToken, userId, instanceUrl, username } =
    await obtainTokensAndUserId(loginUrl);
  console.log();
  console.log(`✅ Signed in as ${username} (user id: ${userId})`);
  console.log(`   Instance URL:  ${instanceUrl}`);
  console.log(`   Access token:  ${maskToken(accessToken)}`);
  console.log(`   Refresh token: ${maskToken(refreshToken)}`);
  console.log();

  // Step 4: build client with in-memory token state.
  let currentAccessToken = accessToken;
  const client = createSalesforceClient({
    instanceUrl,
    apiVersion: config.apiVersion,
    getAccessToken: async () => currentAccessToken,
    forceRefresh: async () => {
      console.log('🔄 Access token expired; refreshing…');
      const fresh = await refreshAccessToken({
        loginUrl,
        clientId: 'PlatformCLI',
        refreshToken,
      });
      currentAccessToken = fresh.access_token;
      return currentAccessToken;
    },
  });

  // Step 5: preview SOQL.
  const { soql } = buildSoql(config, { currentUserId: userId });
  console.log('=== SOQL that will be executed ===');
  console.log(soql);
  console.log();

  // Step 6: run the job (dry run → isActive=false; --update → isActive=true).
  const result = await runJob({
    config,
    isActive: args.doUpdate,
    client,
    currentUserId: userId,
  });

  console.log('=== Result ===');
  console.log(`  Status:        ${result.ok ? '✅ OK' : '❌ FAILED'}`);
  console.log(`  Mode:          ${result.mode}`);
  console.log(`  Matched:       ${result.matchedCount}`);
  if (result.updatedCount !== undefined) {
    console.log(`  Updated:       ${result.updatedCount}`);
  }
  if (result.failedCount !== undefined && result.failedCount > 0) {
    console.log(`  Failed:        ${result.failedCount}`);
  }
  if (result.recordIds.length > 0 && result.recordIds.length <= 20) {
    console.log(`  Record Ids:    ${result.recordIds.join(', ')}`);
  }
  console.log(`  Duration:      ${result.durationMs}ms`);
  console.log();
  console.log(`  Message: ${result.message}`);
  console.log();

  if (!args.doUpdate && result.mode === 'select-only' && result.matchedCount > 0) {
    console.log(
      `🟡 Dry run — no records were modified. Run again with --update to execute the UPDATE.`
    );
  }

  process.exit(result.ok ? 0 : 1);
}

void main().catch((err) => {
  console.error(`❌ ${(err as Error).message}`);
  process.exit(1);
});