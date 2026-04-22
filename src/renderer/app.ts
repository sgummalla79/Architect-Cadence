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
    level: 'info' | 'success' | 'warn' | 'error';
    message: string;
    source?: 'scheduler' | 'engagements';
    durationMs?: number;
    recordIds?: string[];
    runId?: string;
  }

  interface CompanionApi {
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
    fetchEngagements: () => Promise<{ ok: boolean; records: Record<string, unknown>[]; callDurations?: string[]; cardDisplay?: { nameField?: string; titleField?: string; stageField?: string; statusField?: string }; error?: string }>;
    callAction: (recordId: string, actionType: 'customer' | 'internal', duration: string) => Promise<{ ok: boolean; error?: string }>;
    endCall: (recordId: string) => Promise<{ ok: boolean; error?: string }>;
    clearStaleTimers: (scheduledIds: string[]) => Promise<{ ok: boolean }>;
    workingAction: (recordId: string, currentStatus: string) => Promise<{ ok: boolean; error?: string; newStatus?: string }>;
    openRecord: (recordId: string) => Promise<{ ok: boolean; error?: string }>;
    getPaths: () => Promise<{ configPath: string; logPath: string }>;
    onStateChanged: (cb: (state: AppState) => void) => void;
    onTrayRunNow: (cb: () => void) => void;
    onLogAppend: (cb: (entry: LogEntry) => void) => void;
    onAutoEndCall: (cb: (data: { recordId: string; newStatus: string }) => void) => void;
    onEngagementsRefresh: (cb: () => void) => void;
  }

  const cadence = (window as unknown as { companion: CompanionApi }).companion;

  // ============ Helpers ============

  const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(id) as T;

  // ============ Theme ============

  const THEME_KEY = 'companion-theme';
  type Theme = 'dark' | 'light';

  function applyTheme(theme: Theme): void {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }

  (function initTheme(): void {
    const saved = localStorage.getItem(THEME_KEY) as Theme | null;
    if (saved === 'light' || saved === 'dark') {
      applyTheme(saved);
    } else {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      applyTheme(prefersDark ? 'dark' : 'light');
    }
  })();

  $('themeToggle').addEventListener('click', () => {
    const current = (document.documentElement.dataset.theme as Theme | undefined) ?? 'dark';
    applyTheme(current === 'dark' ? 'light' : 'dark');
  });

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

  // ============ Engagements tab ============

  const SCHEDULED_STATUS = 'Call/Meeting Scheduled';

  const DEFAULT_DURATION = '1h';
  let callDurationOptions: string[] = [DEFAULT_DURATION];

  let cardNameField   = 'Name';
  let cardTitleField  = 'Title__c';
  let cardStageField  = 'Stage__c';
  let cardStatusField = 'Engagement_Status__c';

  const ICON_INTERNAL =
    `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="M11 8.5l-2.5 2.5a9 9 0 01-7.5-7.5L3.5 1 5 4 3.8 5.2a6.5 6.5 0 003 3L8 7l3 1.5z"/>` +
    `</svg>`;

  const ICON_EXTERNAL =
    `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="M11 8.5l-2.5 2.5a9 9 0 01-7.5-7.5L3.5 1 5 4 3.8 5.2a6.5 6.5 0 003 3L8 7l3 1.5z"/>` +
    `<path d="M8 1h3v3M11 1L7.5 4.5" stroke-width="1.8"/>` +
    `</svg>`;

  let engagementRecords: Record<string, unknown>[] = [];

  function buildCardHtml(r: Record<string, unknown>): string {
    const id        = escapeHtml(String(r['Id'] ?? ''));
    const name      = escapeHtml(String(r[cardNameField]   ?? ''));
    const title     = escapeHtml(String(r[cardTitleField]  ?? ''));
    const stage     = escapeHtml(String(r[cardStageField]  ?? ''));
    const status    = escapeHtml(String(r[cardStatusField] ?? ''));
    const rawStatus = String(r[cardStatusField] ?? '');
    const isScheduled = rawStatus === SCHEDULED_STATUS;

    const ICON_OPEN =
      `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="12" height="12">` +
      `<path d="M5 2H2a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V7"/>` +
      `<polyline points="8 1 11 1 11 4"/><line x1="11" y1="1" x2="6" y2="6"/>` +
      `</svg>`;

    // Status badge color variant
    let statusVariant = '';
    if (rawStatus === 'In Progress') statusVariant = ' eng-status-badge--active';
    else if (rawStatus === SCHEDULED_STATUS) statusVariant = ' eng-status-badge--scheduled';

    // Row 1: name | stage badge | status badge | open button (all left)
    const row1 =
      `<div class="eng-card-header">` +
        `<span class="eng-card-name">${name}</span>` +
        (stage ? `<span class="eng-card-badge">${stage}</span>` : '') +
        `<span class="eng-status-badge${statusVariant}">${status}</span>` +
        `<button class="eng-open-btn" data-record-id="${id}" data-open="true" title="Open in Salesforce">${ICON_OPEN}</button>` +
      `</div>`;

    // Row 2: title (only if present)
    const row2 = title
      ? `<div class="eng-card-title-row"><span class="eng-card-title">${title}</span></div>`
      : '';

    // Row 3: working button (left) | spacer | duration + call buttons (right)
    const workingBtn = isScheduled
      ? ''
      : (rawStatus === 'In Progress'
          ? `<button class="eng-working-btn eng-working-btn--revert" data-record-id="${id}" data-action="working">Set to Waiting on Customer</button>`
          : `<button class="eng-working-btn" data-record-id="${id}" data-action="working">Set to Working</button>`
        );

    const durationOpts = callDurationOptions
      .map((d) => `<option${d === DEFAULT_DURATION ? ' selected' : ''}>${escapeHtml(d)}</option>`)
      .join('');

    const callBtns = isScheduled
      ? `<button class="eng-end-call-btn" data-record-id="${id}">End Call</button>`
      : `<select class="eng-duration" title="Call duration">${durationOpts}</select>` +
        `<button class="eng-call-btn eng-call-internal" data-record-id="${id}" data-action="internal">${ICON_INTERNAL} Internal Call</button>` +
        `<button class="eng-call-btn eng-call-external" data-record-id="${id}" data-action="customer">${ICON_EXTERNAL} External Call</button>`;

    const row3 =
      `<div class="eng-card-footer">` +
        workingBtn +
        `<span class="eng-footer-spacer"></span>` +
        callBtns +
      `</div>`;

    return `<div class="eng-card" data-record-id="${id}">${row1}${row2}${row3}</div>`;
  }

  function renderEngagements(records: Record<string, unknown>[]): void {
    engagementRecords = records;
    applySearch();
  }

  function applySearch(): void {
    const list = $('engList');
    const count = $('engCount');
    const searchEl = $('engSearch') as HTMLInputElement;
    const clearBtn = $('engSearchClear') as HTMLButtonElement;
    const query = searchEl.value.trim().toLowerCase();

    clearBtn.hidden = query.length === 0;

    if (engagementRecords.length === 0) {
      list.innerHTML = '<div class="eng-empty">No engagements matched the filter.</div>';
      count.textContent = '';
      return;
    }

    const filtered = query
      ? engagementRecords.filter((r) => {
          const name = String(r[cardNameField]  ?? '').toLowerCase();
          const title = String(r[cardTitleField] ?? '').toLowerCase();
          return name.includes(query) || title.includes(query);
        })
      : engagementRecords;

    if (filtered.length === 0) {
      list.innerHTML = '<div class="eng-empty">No engagements match your search.</div>';
      count.textContent = '';
      return;
    }

    const total = engagementRecords.length;
    count.textContent = query
      ? `${filtered.length} of ${total} engagement${total === 1 ? '' : 's'}`
      : `${total} engagement${total === 1 ? '' : 's'}`;
    list.innerHTML = filtered.map(buildCardHtml).join('');
  }

  async function loadEngagements(): Promise<void> {
    const list = $('engList');
    list.innerHTML = '<div class="eng-empty">Loading…</div>';
    $('engCount').textContent = '';
    const result = await cadence.fetchEngagements();
    if (result.ok) {
      if (result.callDurations?.length) callDurationOptions = result.callDurations;
      if (result.cardDisplay) {
        cardNameField   = result.cardDisplay.nameField   ?? cardNameField;
        cardTitleField  = result.cardDisplay.titleField  ?? cardTitleField;
        cardStageField  = result.cardDisplay.stageField  ?? cardStageField;
        cardStatusField = result.cardDisplay.statusField ?? cardStatusField;
      }
      // Clear timers for records whose status changed away from scheduled externally.
      const scheduledIds = (result.records as Record<string, unknown>[])
        .filter((r) => String(r[cardStatusField] ?? '') === SCHEDULED_STATUS)
        .map((r) => String(r['Id'] ?? ''));
      void cadence.clearStaleTimers(scheduledIds);
      renderEngagements(result.records);
    } else {
      list.innerHTML = `<div class="eng-empty">${escapeHtml(result.error ?? 'Failed to load engagements.')}</div>`;
    }
  }

  $('refreshEngBtn').addEventListener('click', () => { void loadEngagements(); });

  ($('engSearch') as HTMLInputElement).addEventListener('input', applySearch);
  $('engSearchClear').addEventListener('click', () => {
    ($('engSearch') as HTMLInputElement).value = '';
    applySearch();
    ($('engSearch') as HTMLInputElement).focus();
  });

  $('engList').addEventListener('click', async (e) => {
    // Open-record icon — no loading state needed
    const openBtn = (e.target as Element).closest<HTMLButtonElement>('[data-open]');
    if (openBtn) {
      void cadence.openRecord(openBtn.dataset.recordId!);
      return;
    }

    const btn = (e.target as Element).closest<HTMLButtonElement>('[data-action], .eng-end-call-btn');
    if (!btn) return;

    const recordId = btn.dataset.recordId!;
    const actionType = btn.dataset.action as 'customer' | 'internal' | 'working' | undefined;

    btn.disabled = true;
    const origHtml = btn.innerHTML;
    btn.innerHTML = 'Saving…';

    try {
      if (actionType === 'customer' || actionType === 'internal') {
        // Read selected duration from the dropdown in this card.
        const card = $('engList').querySelector<HTMLElement>(`[data-record-id="${CSS.escape(recordId)}"]`);
        const durationSelect = card?.querySelector<HTMLSelectElement>('.eng-duration');
        const duration = durationSelect?.value ?? DEFAULT_DURATION;
        const r = await cadence.callAction(recordId, actionType, duration);
        if (r.ok) {
          const idx = engagementRecords.findIndex((rec) => String(rec['Id']) === recordId);
          if (idx !== -1) {
            engagementRecords[idx] = { ...engagementRecords[idx], [cardStatusField]: SCHEDULED_STATUS };
            const cardEl = $('engList').querySelector<HTMLElement>(`[data-record-id="${CSS.escape(recordId)}"]`);
            if (cardEl) cardEl.outerHTML = buildCardHtml(engagementRecords[idx]);
          }
          showToast(`Call scheduled — auto-ends in ${duration}`, 'success');
        } else {
          btn.disabled = false;
          btn.innerHTML = origHtml;
          showToast(r.error ?? 'Action failed', 'error');
        }
      } else if (actionType === 'working') {
        const idx = engagementRecords.findIndex((rec) => String(rec['Id']) === recordId);
        const currentStatus = idx !== -1 ? String(engagementRecords[idx][cardStatusField] ?? '') : '';
        const r = await cadence.workingAction(recordId, currentStatus);
        if (r.ok) {
          if (idx !== -1 && r.newStatus) {
            engagementRecords[idx] = { ...engagementRecords[idx], [cardStatusField]: r.newStatus };
            const card = $('engList').querySelector<HTMLElement>(`[data-record-id="${CSS.escape(recordId)}"]`);
            if (card) card.outerHTML = buildCardHtml(engagementRecords[idx]);
          }
          const toastMsg = currentStatus === 'In Progress' ? 'Set to Waiting on Customer' : 'Marked as Working';
          showToast(toastMsg, 'success');
        } else {
          btn.disabled = false;
          btn.innerHTML = origHtml;
          showToast(r.error ?? 'Action failed', 'error');
        }
      } else {
        // End Call
        btn.innerHTML = 'Ending…';
        const r = await cadence.endCall(recordId);
        if (r.ok) {
          showToast('Call ended', 'success');
          void loadEngagements();
        } else {
          btn.disabled = false;
          btn.innerHTML = origHtml;
          showToast(r.error ?? 'End call failed', 'error');
        }
      }
    } catch (err) {
      btn.disabled = false;
      btn.innerHTML = origHtml;
      showToast((err as Error).message, 'error');
    }
  });

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
    // Session line in header: show connected state or sign-in button
    if (state.isConnected) {
      $('authConnected').hidden = false;
      $('signInBtn').hidden = true;
      $('authUsername').textContent = state.username ?? '';
    } else {
      $('authConnected').hidden = true;
      $('signInBtn').hidden = false;
    }

    // Active pill + icon dim
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

    // Launch-at-startup toggle
    const startupToggle = $('launchAtStartupToggle') as HTMLInputElement;
    const startupDesc = $('startupDesc');
    startupToggle.checked = state.launchAtStartup;
    startupToggle.disabled = !state.startupSupported;
    if (!state.startupSupported) {
      startupDesc.textContent = 'Launch at startup is not supported on this platform.';
    } else {
      startupDesc.textContent =
        'Open Architect Companion automatically when you log in. Starts hidden in the tray.';
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

  function buildLogEntryHtml(l: LogEntry, idx: number): string {
    const dur = l.durationMs !== undefined ? ` <span class="dur">(${l.durationMs}ms)</span>` : '';
    const hasIds = l.recordIds && l.recordIds.length > 0;
    const disclosure = hasIds
      ? ` <button class="ids-toggle" data-log-idx="${idx}" type="button">▸ Show ${l.recordIds!.length} ID${l.recordIds!.length === 1 ? '' : 's'}</button>` +
        `<div class="ids-list" id="ids-${idx}" hidden>${l.recordIds!.map(escapeHtml).join(', ')}</div>`
      : '';
    return `<div class="log-entry ${l.level}"><span class="ts">[${formatTs(l.ts)}]</span>${escapeHtml(l.message)}${dur}${disclosure}</div>`;
  }

  function buildAccordion(
    id: string,
    title: string,
    entries: LogEntry[],
    startIdx: number,
    open: boolean
  ): string {
    const body = entries.length === 0
      ? '<div class="logs-empty">No logs in this window.</div>'
      : entries.map((l, i) => buildLogEntryHtml(l, startIdx + i)).join('');
    const badge = entries.length > 0 ? ` <span class="log-badge">${entries.length}</span>` : '';
    return (
      `<div class="log-accordion">` +
        `<button class="accordion-header${open ? ' open' : ''}" data-accordion="${id}">` +
          `<span class="accordion-arrow">${open ? '▾' : '▸'}</span>${escapeHtml(title)}${badge}` +
        `</button>` +
        `<div class="accordion-body" id="acc-${id}"${open ? '' : ' hidden'}>${body}</div>` +
      `</div>`
    );
  }

  function wireAccordions(container: HTMLElement): void {
    container.querySelectorAll<HTMLButtonElement>('.accordion-header').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.accordion!;
        const body = document.getElementById(`acc-${id}`) as HTMLElement;
        const isOpen = !body.hidden;
        body.hidden = isOpen;
        btn.classList.toggle('open', !isOpen);
        btn.querySelector<HTMLElement>('.accordion-arrow')!.textContent = isOpen ? '▸' : '▾';
      });
    });
    container.querySelectorAll<HTMLButtonElement>('.ids-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.logIdx!);
        const list = document.getElementById(`ids-${idx}`) as HTMLDivElement;
        const isHidden = list.hidden;
        list.hidden = !isHidden;
        const count = (allLogs[idx].recordIds ?? []).length;
        btn.textContent = `${isHidden ? '▾' : '▸'} ${isHidden ? 'Hide' : 'Show'} ${count} ID${count === 1 ? '' : 's'}`;
      });
    });
  }

  function renderLogs(): void {
    const container = $('logs');
    if (allLogs.length === 0) {
      container.innerHTML = '<div class="logs-empty">No logs yet.</div>';
      return;
    }

    const engLogs = allLogs.filter((l) => l.source === 'engagements');
    // Entries with no source are legacy scheduler logs written before source field was added.
    const schedLogs = allLogs.filter((l) => l.source === 'scheduler' || !l.source);

    // Build both accordions; engagement entries are indexed 0..n-1, scheduler n..n+m-1
    // so ids-N references are globally unique across the full allLogs array.
    const engStartIdx = 0;
    const schedStartIdx = engLogs.length;

    container.innerHTML =
      buildAccordion('engagements', 'Engagement View Logs', engLogs, engStartIdx, true) +
      buildAccordion('scheduler', 'Daily Scheduler Logs', schedLogs, schedStartIdx, true);

    wireAccordions(container);
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

  $('signOutBtn').addEventListener('click', async () => {
    if (!confirm('Sign out? You will need to sign in again to run updates.')) return;
    const r = await cadence.resetConnection();
    if (r.ok) {
      render(r.state);
      showToast('Signed out', 'info');
    }
  });

  $('signInBtn').addEventListener('click', async () => {
    const btn = $('signInBtn') as HTMLButtonElement;
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Waiting for browser…';
    try {
      const r = await cadence.signIn();
      if (r.ok) {
        render(r.state);
        showToast(`Signed in as ${r.state.username}`, 'success');
        void loadEngagements();
      } else {
        showToast(r.message ?? 'Sign-in failed', 'error');
        btn.disabled = false;
        btn.textContent = orig;
      }
    } catch (err) {
      showToast((err as Error).message, 'error');
      btn.disabled = false;
      btn.textContent = orig;
    }
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

  let wasConnected = false;
  cadence.onStateChanged((state) => {
    render(state);
    if (state.isConnected && !wasConnected) {
      void loadEngagements();
    }
    wasConnected = state.isConnected;
  });
  cadence.onTrayRunNow(() => {
    // Tray-initiated runs result in a log:append from main.
  });
  cadence.onLogAppend((entry) => {
    // Insert newest-first (same order as readLogs returns).
    allLogs = [entry, ...allLogs];
    renderLogs();
  });
  cadence.onEngagementsRefresh(() => {
    void loadEngagements();
  });
  cadence.onAutoEndCall(({ recordId, newStatus }) => {
    const idx = engagementRecords.findIndex((r) => String(r['Id']) === recordId);
    if (idx !== -1) {
      engagementRecords[idx] = { ...engagementRecords[idx], [cardStatusField]: newStatus };
      const card = $('engList').querySelector<HTMLElement>(`[data-record-id="${CSS.escape(recordId)}"]`);
      if (card) card.outerHTML = buildCardHtml(engagementRecords[idx]);
    }
  });

  // ============ Boot ============

  cadence.getState().then(render);
  void loadEngagements();
  void refreshLogsFromMain();
  void loadConfigEditor();
  void cadence.getPaths().then((p) => {
    $('aboutConfigPath').textContent = p.configPath;
    $('aboutLogPath').textContent = p.logPath;

    function wireCopyBtn(btnId: string, text: string): void {
      const btn = $(btnId) as HTMLButtonElement;
      btn.addEventListener('click', () => {
        void navigator.clipboard.writeText(text).then(() => {
          btn.classList.add('copied');
          setTimeout(() => btn.classList.remove('copied'), 1500);
        });
      });
    }
    wireCopyBtn('copyConfigPath', p.configPath);
    wireCopyBtn('copyLogPath', p.logPath);
  });
})();