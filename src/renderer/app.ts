// Renderer-side logic.
// Wrapped in an IIFE so top-level declarations don't leak to global scope.

(() => {
  console.log('[renderer] script loaded at', new Date().toISOString());

  interface AppState {
    isActive: boolean;
    isConnected: boolean;
    scheduledTime: string;
    username: string | null;
    orgDomain: string | null;
    launchAtStartup: boolean;
    startupSupported: boolean;
  }

  interface ActionResult {
    ok: boolean;
    message?: string;
  }

  type LogWindowKey = 'last-run' | '3d' | '7d' | '15d' | '30d';

  interface LogEntry {
    ts: string;
    level: 'info' | 'success' | 'error';
    message: string;
    durationMs?: number;
    recordIds?: string[];
    runId?: string;
  }

  interface CadenceApi {
    getState: () => Promise<AppState>;
    setActive: (isActive: boolean) => Promise<AppState>;
    setTime: (time: string) => Promise<AppState>;
    setLaunchAtStartup: (enabled: boolean) => Promise<AppState>;
    runNow: () => Promise<ActionResult>;
    signIn: () => Promise<{ ok: boolean; state: AppState; message?: string }>;
    resetConnection: () => Promise<{ ok: boolean; state: AppState }>;
    testConnection: () => Promise<ActionResult>;
    configRead: () => Promise<{ ok: boolean; text: string }>;
    configValidate: (text: string) => Promise<{ ok: boolean; message?: string; errors?: string[] }>;
    configSave: (text: string) => Promise<{ ok: boolean; message?: string; formatted?: string; errors?: string[] }>;
    getLogs: (window: LogWindowKey) => Promise<{ ok: boolean; entries: LogEntry[]; message?: string }>;
    clearLogs: () => Promise<{ ok: boolean; message?: string }>;
    getPaths: () => Promise<{ configPath: string; logPath: string }>;
    onStateChanged: (cb: (state: AppState) => void) => void;
    onTrayRunNow: (cb: () => void) => void;
    onLogAppend: (cb: (entry: LogEntry) => void) => void;
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
    const connStatus = $('connStatus');
    const connStatusLabel = connStatus.querySelector('.status-label')!;
    if (state.isConnected) {
      connStatus.classList.remove('disconnected');
      connStatus.classList.add('connected');
      connStatusLabel.textContent = 'Connected';
    } else {
      connStatus.classList.remove('connected');
      connStatus.classList.add('disconnected');
      connStatusLabel.textContent = 'Disconnected';
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

    // Launch-at-startup toggle
    const startupToggle = $('launchAtStartupToggle') as HTMLInputElement;
    const startupDesc = $('startupDesc');
    startupToggle.checked = state.launchAtStartup;
    startupToggle.disabled = !state.startupSupported;
    if (!state.startupSupported) {
      startupDesc.textContent = 'Launch at startup is not supported on this platform.';
    } else {
      startupDesc.textContent =
        'Open Architect Cadence automatically when you log in. Starts hidden in the tray.';
    }
  }

  // ============ Logs ============

  let allLogs: LogEntry[] = [];
  let currentWindow: LogWindowKey = '3d';

  function formatTs(ts: string): string {
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function renderLogs(): void {
    const container = $('logs');
    if (allLogs.length === 0) {
      container.innerHTML = '<div class="logs-empty">No logs yet.</div>';
      return;
    }
    container.innerHTML = allLogs
      .map((l, idx) => {
        const dur = l.durationMs !== undefined ? ` <span class="dur">(${l.durationMs}ms)</span>` : '';
        const hasIds = l.recordIds && l.recordIds.length > 0;
        const disclosure = hasIds
          ? ` <button class="ids-toggle" data-log-idx="${idx}" type="button">▸ Show ${l.recordIds!.length} ID${l.recordIds!.length === 1 ? '' : 's'}</button>` +
            `<div class="ids-list" id="ids-${idx}" hidden>${l.recordIds!.map(escapeHtml).join(', ')}</div>`
          : '';
        return `<div class="log-entry ${l.level}"><span class="ts">[${formatTs(l.ts)}]</span>${escapeHtml(l.message)}${dur}${disclosure}</div>`;
      })
      .join('');

    // Wire toggle buttons (delegated would also work; explicit is simpler here).
    container.querySelectorAll<HTMLButtonElement>('.ids-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = btn.dataset.logIdx!;
        const list = document.getElementById(`ids-${idx}`) as HTMLDivElement;
        const isHidden = list.hidden;
        list.hidden = !isHidden;
        const count = (allLogs[Number(idx)].recordIds ?? []).length;
        btn.textContent = `${isHidden ? '▾' : '▸'} ${isHidden ? 'Hide' : 'Show'} ${count} ID${count === 1 ? '' : 's'}`;
      });
    });
  }

  async function refreshLogsFromMain(): Promise<void> {
    const result = await cadence.getLogs(currentWindow);
    if (result.ok) {
      allLogs = result.entries;
      renderLogs();
    }
  }

  // ============ Config editor ============

  let savedConfigText = ''; // last persisted text — used to detect "dirty"
  let isEditingConfig = false;

  function setEditorMode(editing: boolean): void {
    isEditingConfig = editing;
    const editor = $('configEditor') as HTMLTextAreaElement;
    const editBtn = $('editConfigBtn') as HTMLButtonElement;

    editor.readOnly = !editing;
    editBtn.textContent = editing ? 'Cancel' : 'Edit';
    updateSaveButtonState();

    if (editing) editor.focus();
  }

  function isDirty(): boolean {
    if (!isEditingConfig) return false;
    const editor = $('configEditor') as HTMLTextAreaElement;
    return editor.value !== savedConfigText;
  }

  function updateSaveButtonState(): void {
    const saveBtn = $('saveConfigBtn') as HTMLButtonElement;
    saveBtn.disabled = !isDirty();

    const status = $('configStatus');
    if (isEditingConfig && isDirty()) {
      status.textContent = 'Unsaved changes';
      status.className = 'config-status dirty';
    }
  }

  function setConfigStatus(text: string, kind: 'success' | 'error' | '' = ''): void {
    const status = $('configStatus');
    status.textContent = text;
    status.className = `config-status${kind ? ' ' + kind : ''}`;
  }

  async function loadConfigEditor(): Promise<void> {
    const result = await cadence.configRead();
    if (result.ok) {
      const editor = $('configEditor') as HTMLTextAreaElement;
      editor.value = result.text;
      savedConfigText = result.text;
      setEditorMode(false);
      setConfigStatus('Loaded from disk');
    } else {
      setConfigStatus('Could not read config', 'error');
    }
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

  $('signInBtn').addEventListener('click', async () => {
    const signInBtn = $('signInBtn') as HTMLButtonElement;
    const originalText = signInBtn.textContent;
    signInBtn.disabled = true;
    signInBtn.textContent = 'Waiting for browser…';
    try {
      const r = await cadence.signIn();
      if (r.ok) {
        render(r.state);
        showToast(`Signed in as ${r.state.username}`, 'success');
      } else {
        showToast(r.message ?? 'Sign-in failed', 'error');
        signInBtn.disabled = false;
        signInBtn.textContent = originalText;
      }
    } catch (err) {
      showToast((err as Error).message, 'error');
      signInBtn.disabled = false;
      signInBtn.textContent = originalText;
    }
  });

  $('resetBtn').addEventListener('click', async () => {
    if (!confirm('Reset connection? You will need to sign in again to run updates.')) return;
    const r = await cadence.resetConnection();
    if (r.ok) {
      render(r.state);
      showToast('Connection reset');
    }
  });

  $('testConnBtn').addEventListener('click', async () => {
    const r = await cadence.testConnection();
    showToast(r.message ?? (r.ok ? 'OK' : 'Failed'), r.ok ? 'success' : 'error');
  });

  // --- Config editor ---

  $('editConfigBtn').addEventListener('click', () => {
    if (isEditingConfig) {
      // Currently editing → behave as Cancel.
      if (isDirty()) {
        if (!confirm('Discard unsaved changes?')) return;
      }
      const editor = $('configEditor') as HTMLTextAreaElement;
      editor.value = savedConfigText;
      setEditorMode(false);
      setConfigStatus('Changes discarded');
    } else {
      setEditorMode(true);
      setConfigStatus('Editing — make changes, then click Save');
    }
  });

  $('validateConfigBtn').addEventListener('click', async () => {
    const editor = $('configEditor') as HTMLTextAreaElement;
    const r = await cadence.configValidate(editor.value);
    if (r.ok) {
      setConfigStatus(`✓ ${r.message ?? 'Config valid'}`, 'success');
    } else {
      const errs = r.errors ?? [r.message ?? 'Invalid'];
      setConfigStatus(`✗ ${errs.join('\n  ')}`, 'error');
    }
  });

  $('saveConfigBtn').addEventListener('click', async () => {
    const editor = $('configEditor') as HTMLTextAreaElement;
    const r = await cadence.configSave(editor.value);
    if (r.ok) {
      // Auto-format applied by main; reflect that in the editor.
      if (r.formatted) {
        editor.value = r.formatted;
        savedConfigText = r.formatted;
      } else {
        savedConfigText = editor.value;
      }
      setEditorMode(false);
      setConfigStatus('✓ Saved', 'success');
      showToast('Config saved', 'success');
    } else {
      const errs = r.errors ?? [r.message ?? 'Save failed'];
      setConfigStatus(`✗ Cannot save:\n  ${errs.join('\n  ')}`, 'error');
      showToast('Config invalid — see details', 'error');
    }
  });

  $('configEditor').addEventListener('input', () => {
    if (isEditingConfig) updateSaveButtonState();
  });

  $('logRange').addEventListener('change', async (e) => {
    currentWindow = (e.target as HTMLSelectElement).value as LogWindowKey;
    await refreshLogsFromMain();
  });

  $('clearLogs').addEventListener('click', async () => {
    if (!confirm('Clear all execution history? This cannot be undone.')) return;
    const result = await cadence.clearLogs();
    if (result.ok) {
      allLogs = [];
      renderLogs();
      showToast('Execution history cleared', 'info');
    }
  });

  $('launchAtStartupToggle').addEventListener('change', async (e) => {
    const enabled = (e.target as HTMLInputElement).checked;
    const updated = await cadence.setLaunchAtStartup(enabled);
    render(updated);
    showToast(
      enabled ? 'Will launch at startup' : 'Launch at startup disabled',
      enabled ? 'success' : 'info'
    );
  });

  // ============ Subscriptions ============

  cadence.onStateChanged((state) => render(state));
  cadence.onTrayRunNow(() => {
    // Tray-initiated runs result in a log:append from main.
  });
  cadence.onLogAppend((_entry) => {
    void refreshLogsFromMain();
  });

  // ============ Boot ============

  cadence.getState().then(render);
  void refreshLogsFromMain();
  void loadConfigEditor();
  void cadence.getPaths().then((p) => {
    $('aboutConfigPath').textContent = p.configPath;
    $('aboutLogPath').textContent = p.logPath;
  });
})();