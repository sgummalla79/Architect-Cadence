// Renderer-side logic.
// Wrapped in an IIFE so top-level declarations don't leak to global scope.
// This means if the script somehow gets loaded twice (hot-reload, caching quirks,
// etc.), each load creates its own scope and `const cadence` can never collide.

(() => {
  console.log('[renderer] script loaded at', new Date().toISOString());

  interface AppState {
    isActive: boolean;
    isConnected: boolean;
    scheduledTime: string;
    username: string | null;
    orgDomain: string | null;
  }

  interface ActionResult {
    ok: boolean;
    message?: string;
  }

  interface CadenceApi {
    getState: () => Promise<AppState>;
    setActive: (isActive: boolean) => Promise<AppState>;
    setTime: (time: string) => Promise<AppState>;
    runNow: () => Promise<ActionResult>;
    signIn: () => Promise<{ ok: boolean; state: AppState; message?: string }>;
    resetConnection: () => Promise<{ ok: boolean; state: AppState }>;
    testConnection: () => Promise<ActionResult>;
    editConfig: () => Promise<ActionResult>;
    validateConfig: () => Promise<ActionResult>;
    clearLogs: () => Promise<ActionResult>;
    onStateChanged: (cb: (state: AppState) => void) => void;
    onTrayRunNow: (cb: () => void) => void;
    onLogAppend: (cb: (entry: { ts: string; level: 'info' | 'success' | 'error'; message: string }) => void) => void;
  }

  const cadence = (window as unknown as { cadence: CadenceApi }).cadence;

  // ============ Helpers ============

  const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(id) as T;

  function showToast(message: string, kind: 'success' | 'error' | 'info' = 'info'): void {
    const toast = $('toast');
    toast.textContent = message;
    toast.className = `toast show ${kind === 'info' ? '' : kind}`;
    window.setTimeout(() => (toast.className = 'toast'), 2400);
  }

  function formatTime12h(hhmm: string): string {
    const [h, m] = hhmm.split(':').map(Number);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
  }

  function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)
    );
  }

  // ============ Tab switching ============

  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab!;
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      document.querySelector(`.tab-panel[data-panel="${target}"]`)!.classList.add('active');
    });
  });

  // ============ State rendering ============

  function render(state: AppState): void {
    const orgBar = $('orgBar');
    const orgText = $('orgText');
    if (state.isConnected) {
      orgBar.classList.add('connected');
      orgText.textContent = `${state.orgDomain} · ${state.username}`;
    } else {
      orgBar.classList.remove('connected');
      orgText.textContent = 'Not connected';
    }

    const pill = $('activeToggle');
    const pillLabel = pill.querySelector('.pill-label')!;
    const appIcon = $('appIcon');
    if (state.isActive) {
      pill.classList.remove('inactive');
      appIcon.classList.remove('inactive');
      pillLabel.textContent = 'Active';
    } else {
      pill.classList.add('inactive');
      appIcon.classList.add('inactive');
      pillLabel.textContent = 'Inactive';
    }

    ($('timeInput') as HTMLInputElement).value = state.scheduledTime;
    $('nextRun').textContent = state.isActive
      ? `Next run: ${formatTime12h(state.scheduledTime)} (local time)`
      : 'Scheduled runs disabled';

    const runNowBtn = $('runNowBtn') as HTMLButtonElement;
    runNowBtn.disabled = !state.isConnected;
    runNowBtn.title = state.isConnected ? '' : 'Sign in first';

    const connDot = $('connDot');
    const connPrimary = $('connPrimary');
    const connSecondary = $('connSecondary');
    const signInBtn = $('signInBtn') as HTMLButtonElement;
    const testConnBtn = $('testConnBtn') as HTMLButtonElement;
    const resetBtn = $('resetBtn') as HTMLButtonElement;

    if (state.isConnected) {
      connDot.classList.add('connected');
      connPrimary.textContent = `Connected as ${state.username}`;
      connSecondary.textContent = state.orgDomain ?? '';
      signInBtn.disabled = true;
      signInBtn.textContent = 'Signed in';
      testConnBtn.disabled = false;
      resetBtn.disabled = false;
    } else {
      connDot.classList.remove('connected');
      connPrimary.textContent = 'Not connected';
      connSecondary.textContent = 'Sign in to authorize Salesforce access';
      signInBtn.disabled = false;
      signInBtn.textContent = 'Sign in to Salesforce';
      testConnBtn.disabled = true;
      resetBtn.disabled = true;
    }
  }

  // ============ Log rendering ============

  interface LogEntry {
    ts: string;
    level: 'success' | 'error' | 'info';
    message: string;
  }

  const logs: LogEntry[] = [];

  function renderLogs(): void {
    const container = $('logs');
    if (logs.length === 0) {
      container.innerHTML = '<div class="logs-empty">No logs yet.</div>';
      return;
    }
    container.innerHTML = logs
      .map(
        (l) =>
          `<div class="log-entry ${l.level}"><span class="ts">[${l.ts}]</span>${escapeHtml(l.message)}</div>`
      )
      .join('');
  }

  function addLog(message: string, level: LogEntry['level'] = 'info'): void {
    const ts = new Date().toLocaleString('sv-SE').replace('T', ' ');
    logs.unshift({ ts, level, message });
    renderLogs();
  }

  // ============ Button handlers ============

  $('activeToggle').addEventListener('click', async () => {
    const s = await cadence.getState();
    const next = !s.isActive;
    const updated = await cadence.setActive(next);
    render(updated);
    showToast(next ? 'Schedule activated' : 'Schedule deactivated', next ? 'success' : 'info');
  });

  $('timeInput').addEventListener('change', async (e) => {
    const val = (e.target as HTMLInputElement).value;
    const updated = await cadence.setTime(val);
    render(updated);
  });

  $('runNowBtn').addEventListener('click', async () => {
    const runNowBtn = $('runNowBtn') as HTMLButtonElement;
    const originalText = runNowBtn.textContent;
    runNowBtn.disabled = true;
    runNowBtn.textContent = 'Running…';
    try {
      const r = await cadence.runNow();
      showToast(r.message ?? (r.ok ? 'Run complete' : 'Run failed'), r.ok ? 'success' : 'error');
    } finally {
      runNowBtn.disabled = false;
      runNowBtn.textContent = originalText;
    }
  });

  $('clearLogsBtn').addEventListener('click', async () => {
    logs.length = 0;
    renderLogs();
    await cadence.clearLogs();
    showToast('Logs cleared (display only)');
  });

  $('signInBtn').addEventListener('click', async () => {
    addLog('Sign In clicked — opening browser…', 'info');
    const signInBtn = $('signInBtn') as HTMLButtonElement;
    const originalText = signInBtn.textContent;
    signInBtn.disabled = true;
    signInBtn.textContent = 'Waiting for browser…';
    try {
      const r = await cadence.signIn();
      if (r.ok) {
        render(r.state);
        addLog(`Signed in as ${r.state.username}`, 'success');
        showToast(`Signed in as ${r.state.username}`, 'success');
      } else {
        addLog(r.message ?? 'Sign-in failed', 'error');
        showToast(r.message ?? 'Sign-in failed', 'error');
        signInBtn.disabled = false;
        signInBtn.textContent = originalText;
      }
    } catch (err) {
      addLog((err as Error).message, 'error');
      showToast('Sign-in failed', 'error');
      signInBtn.disabled = false;
      signInBtn.textContent = originalText;
    }
  });

  $('resetBtn').addEventListener('click', async () => {
    if (!confirm('Reset connection? You will need to sign in again to run updates.')) return;
    const r = await cadence.resetConnection();
    if (r.ok) {
      render(r.state);
      addLog('Connection reset', 'info');
      showToast('Connection reset');
    }
  });

  $('testConnBtn').addEventListener('click', async () => {
    const r = await cadence.testConnection();
    showToast(r.message ?? (r.ok ? 'OK' : 'Failed'), r.ok ? 'success' : 'error');
  });

  $('editConfigBtn').addEventListener('click', async () => {
    await cadence.editConfig();
    showToast('Edit Config (stub) — Module 2');
  });

  $('validateConfigBtn').addEventListener('click', async () => {
    const r = await cadence.validateConfig();
    const status = $('configStatus');
    status.textContent = r.ok ? `✓ ${r.message ?? 'Config valid'}` : `✗ ${r.message ?? 'Invalid'}`;
    status.className = `config-status ${r.ok ? 'success' : 'error'}`;
  });

  // ============ Subscriptions ============

  cadence.onStateChanged((state) => render(state));
  cadence.onTrayRunNow(() => {
    addLog('Run Now triggered from tray', 'info');
  });
  cadence.onLogAppend((entry) => {
    logs.unshift(entry);
    renderLogs();
  });

  // ============ Boot ============

  cadence.getState().then(render);
})();