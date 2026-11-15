// Qline Phase 0 clickable prototype. All data is sample data; no network calls, no backend.
(function () {
  const { Core, AGENTS } = window.QlineCore;
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ───────── icons (24px, stroke) ─────────
  const P = {
    home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
    work: '<path d="m9 11 3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
    business: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18"/>',
    library: '<path d="M4 19.5V5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0-2 2.5z"/><path d="M8 7h8M8 11h6"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    shield: '<path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    right: '<path d="m9 6 6 6-6 6"/>',
    back: '<path d="M15 18 9 12l6-6"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    micoff: '<path d="M2 2l20 20M9 9v2a3 3 0 0 0 5 2.2M15 9.3V6a3 3 0 0 0-5.7-1.3"/><path d="M5 11a7 7 0 0 0 11.5 5.3M19 11a7 7 0 0 1-.6 2.8M12 18v3"/>',
    send: '<path d="M12 19V5M5 12l7-7 7 7"/>',
    stop: '<rect x="7" y="7" width="10" height="10" rx="2"/>',
    clip: '<path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
    check: '<path d="m5 12 5 5 9-10"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
    cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    plug: '<path d="M9 7V3M15 7V3M6 7h12v4a6 6 0 0 1-12 0zM12 17v4"/>',
    sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
    flow: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 7v10M18 11c0 4-6 3-12 6"/>',
    upload: '<path d="M12 16V4M6 10l6-6 6 6M4 20h16"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2"/>',
    copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5"/>',
    wifioff: '<path d="M2 2l20 20M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5.2-2.8M12 20h.01M19 13a10 10 0 0 0-2.4-1.7M2 8.8a15 15 0 0 1 4.2-2.6M22 8.8A15 15 0 0 0 11 5"/>',
    signal: '<path d="M4 20v-3M9 20v-7M14 20V9M19 20V4"/>',
    battery: '<rect x="2" y="7" width="17" height="10" rx="2"/><path d="M22 11v2M5 10h9v4H5z"/>',
    book: '<path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2zM22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z"/>',
    dollar: '<path d="M12 2v20M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
    swap: '<path d="M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/>',
  };
  const ic = (n, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${P[n] || ''}</svg>`;
  const LOGO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="10" cy="10.5" r="7.5"/><path d="M10 18H22"/></svg>';

  // ───────── sample workspace ─────────
  const WS = { name: 'Harbor & Pine Studio', short: 'HP', meta: '4 people · USD · Sample workspace' };
  const PEOPLE = { AL: 'Ana Lim', JR: 'Jo Reyes', MS: 'Mika Santos', DV: 'Dan Villa' };
  const TASKS = [
    { id: 't1', t: 'Send revised logo files to Kestrel Coffee', due: 'Today', who: 'AL', src: 'Imported · tasks.csv', done: false, tag: 'today' },
    { id: 't2', t: 'Prepare Maren Dental proposal v2', due: 'Today', who: 'JR', src: 'Imported · tasks.csv', done: false, tag: 'today' },
    { id: 't3', t: 'Review Northfield Books brief', due: 'Tomorrow', who: 'MS', src: 'Added by you', done: false, tag: 'upcoming' },
    { id: 't4', t: 'Invoice Alder & Co. — October retainer', due: 'Overdue 2d', who: 'DV', src: 'Imported · tasks.csv', done: false, tag: 'today', late: true },
    { id: 't5', t: 'Archive September moodboards', due: 'Done', who: 'AL', src: 'Added by you', done: true, tag: 'done' },
  ];
  const APPROVALS = [
    { id: 'a1', what: 'Send invoice reminder to Alder & Co.', kind: 'External email', risk: 'med', agent: 'ceo', why: 'Invoice INV-0142 ($2,400) is 2 days overdue. You asked me to draft reminders for overdue invoices.', target: 'billing@alder.example', preview: 'Hi Priya — a quick reminder that invoice INV-0142 for October’s retainer ($2,400) was due on Nov 13. Happy to resend the PDF if useful. — Dan, Harbor & Pine', src: ['invoices.csv · row 18', 'Your instruction · Nov 12'] },
    { id: 'a2', what: 'Create 3 client records from import', kind: 'Internal write', risk: 'low', agent: 'ceo', why: 'clients.csv contained 3 clients not yet in the workspace.', target: 'CRM · Clients', preview: 'Northfield Books · Lighthouse Yoga · Brightwater Co-op', src: ['clients.csv · rows 4, 9, 11'] },
  ];
  const CLIENTS = [
    { n: 'Kestrel Coffee', s: 'Active · 2 projects', v: '$4,800 / mo', st: 'ok' },
    { n: 'Alder & Co.', s: 'Active · invoice overdue', v: '$2,400 / mo', st: 'warn' },
    { n: 'Maren Dental', s: 'Proposal sent Nov 10', v: '$9,500 est.', st: 'info' },
    { n: 'Northfield Books', s: 'Lead · from import', v: '—', st: 'off' },
  ];

  // ───────── state ─────────
  const reducePref = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const S = {
    screen: 'welcome', theme: 'dark', reduce: reducePref, agent: 'ceo', homeEmpty: false,
    sheet: null, toast: null, mode: 'hybrid', workTab: 'today', libTab: 'docs', agentTab: 'about',
    approvals: APPROVALS.map((a) => ({ ...a, status: 'pending' })), apprId: 'a1',
    proposal: { dept: true, clients: true, tasks: true, sop: true, rename: false },
    tasks: TASKS.map((t) => ({ ...t })),
    live: { state: 'idle', utter: '', steps: [], resp: null, appr: false, micDenied: false, err: false, sim: false },
  };
  const core = new Core(); const welcomeCore = new Core(); welcomeCore.agent = 'ceo';
  let timers = [];
  const later = (fn, ms) => timers.push(setTimeout(fn, S.reduce ? Math.min(ms, 300) : ms));
  const clearTimers = () => { timers.forEach(clearTimeout); timers = []; };

  const SCREENS = [
    { g: 'Onboarding', items: [['welcome', 'Welcome', '01'], ['signin', 'Sign in', '02'], ['mode', 'Setup mode', '03'], ['interview', 'Business interview', '04'], ['data', 'Add your data', '05'], ['mapping', 'Field mapping', '06'], ['proposal', 'Review proposal', '07']] },
    { g: 'Core', items: [['home', 'Home', '08'], ['live', 'Live AI', '09'], ['approvals', 'Approvals', '10'], ['approval', 'Approval detail', '11'], ['work', 'Work', '12']] },
    { g: 'Workforce', items: [['workforce', 'AI workforce', '13'], ['agent', 'Agent profile', '14']] },
    { g: 'Business', items: [['business', 'Business hub', '15'], ['crm', 'Clients', '16'], ['library', 'Library', '17'], ['automation', 'Automation', '18'], ['integrations', 'Integrations', '19'], ['settings', 'Settings', '20']] },
  ];
  const TITLES = Object.fromEntries(SCREENS.flatMap((g) => g.items.map(([k, t, n]) => [k, { t, n }])));

  // ───────── shared fragments ─────────
  const sb = () => `<div class="sb" aria-hidden="true"><span>9:41</span><span class="sb-ico">${ic('signal')}${ic('battery')}</span></div>`;
  const topbar = (badge = true) => {
    const pending = S.approvals.filter((a) => a.status === 'pending').length;
    return `<div class="topbar">
      <button class="ws-switch" data-act="sheet:switcher" aria-label="Switch workspace, current ${esc(WS.name)}"><span class="ws-chip">${WS.short}</span><span style="min-width:0"><span class="ws-name">${esc(WS.name)}</span><span class="ws-meta">Sample workspace</span></span>${ic('down', 'style="width:16px;height:16px;flex:none;color:var(--text-3)"')}</button>
      <button class="icon-btn" aria-label="Search" data-act="toast:Search is planned for Phase 2 — not in this prototype.">${ic('search')}</button>
      <button class="icon-btn" aria-label="Approvals, ${pending} pending" data-go="approvals">${ic('shield')}${badge && pending ? `<span class="badge">${pending}</span>` : ''}</button>
    </div>`;
  };
  const bnav = (cur) => `<nav class="bnav" aria-label="Main">
    ${[['home', 'Home', 'home'], ['work', 'Work', 'work']].map(([k, l, i]) => `<button data-go="${k}" ${cur === k ? 'aria-current="page"' : ''}>${ic(i)}<span>${l}</span></button>`).join('')}
    <button class="core-btn" data-go="live" aria-label="Live AI — talk to ${AGENTS[S.agent].name}"><span class="mini"></span><span>Live AI</span></button>
    ${[['business', 'Business', 'business'], ['library', 'Library', 'library']].map(([k, l, i]) => `<button data-go="${k}" ${cur === k ? 'aria-current="page"' : ''}>${ic(i)}<span>${l}</span></button>`).join('')}
  </nav>`;
  const header = (title, back, right = '') => `<div class="header"><button class="icon-btn" data-go="${back}" aria-label="Back">${ic('back')}</button><div class="ttl">${title}</div>${right}</div>`;
  const progress = (n) => `<div class="progress" aria-label="Step ${n} of 5">${[1, 2, 3, 4, 5].map((i) => `<span class="${i <= n ? 'on' : ''}"></span>`).join('')}</div>`;
  const agentChip = (k) => `<span class="agent-chip" style="color:${AGENTS[k].hue}"><span class="hue" style="background:${AGENTS[k].hue}"></span><span style="color:var(--text-2)">${AGENTS[k].name}</span></span>`;
  const riskLbl = { low: 'Low risk', med: 'Medium risk', high: 'High risk' };

  // ───────── screens ─────────
  const V = {};
  V.welcome = () => `<section class="screen">${sb()}<div class="welcome"><canvas id="wcore" aria-hidden="true"></canvas>
    <div class="copy">
      <div class="wordmark">${LOGO}<b>Qline</b></div>
      <h1 class="h-display" style="margin-top:14px">Your business, run by a team you can see.</h1>
      <p class="muted" style="margin:10px 0 22px;font-size:15px">AI agents that plan, draft and organise — and always ask before acting on your behalf.</p>
      <button class="btn btn-primary" data-go="signin">Get started</button>
      <button class="btn btn-ghost" data-go="signin" style="margin-top:6px">I already have an account</button>
    </div></div></section>`;

  V.signin = () => `<section class="screen">${sb()}${header('', 'welcome')}<div class="scroll">
    <h1 class="h-title">Create your account</h1><p class="muted" style="margin:6px 0 22px">One account, any number of workspaces.</p>
    <button class="btn btn-secondary" data-act="toast:Google sign-in needs an OAuth client — planned, not connected.">Continue with Google</button>
    <div class="meta" style="text-align:center;margin:18px 0">or</div>
    <div class="field"><label for="em">Work email</label><div class="input filled" id="em">dan@harborpine.example</div></div>
    <div class="field"><label for="pw">Password</label><div class="input" id="pw">At least 12 characters</div></div>
    <button class="btn btn-primary" data-go="mode">Create account</button>
    <p class="meta" style="margin-top:14px">Prototype: no account is created and no email is sent.</p>
  </div></section>`;

  V.mode = () => {
    const m = (k, t, d, rec) => `<button class="mode" aria-pressed="${S.mode === k}" data-act="mode:${k}"><span class="mt">${t}${rec ? '<span class="rec">Recommended</span>' : ''}</span><span class="muted" style="font-size:13px">${d}</span></button>`;
    return `<section class="screen">${sb()}${header('', 'signin')}${progress(1)}<div class="scroll" style="padding-top:18px">
      <h1 class="h-title">How should we set up Harbor &amp; Pine?</h1><p class="muted" style="margin:6px 0 18px">You can change anything later. Nothing is created until you approve it.</p>
      <div class="stack">${m('hybrid', 'Interview + your files', 'A short conversation, then import what you already have. Best accuracy.', true)}${m('interview', 'Interview only', 'Answer 8–12 questions. Good if your data is scattered.')}${m('import', 'Import only', 'Upload spreadsheets or connect a source. We map, you review.')}${m('blank', 'Start blank', 'An empty workspace with just the AI CEO.')}</div>
    </div><div class="sticky-foot"><button class="btn btn-primary" data-go="${S.mode === 'import' ? 'data' : S.mode === 'blank' ? 'home' : 'interview'}">Continue</button></div></section>`;
  };

  V.interview = () => `<section class="screen">${sb()}${header('<span class="meta mono">Question 3 of 9</span>', 'mode', '<button class="btn btn-ghost btn-sm" data-go="data">Skip</button>')}${progress(2)}<div class="scroll" style="padding-top:16px">
    <div class="stack">
      <div class="q-bubble">What do clients usually hire you for, and how does a typical project run from first call to final invoice?</div>
      <div class="a-bubble">Mostly brand identity and packaging. Discovery call, proposal, 50% deposit, two concept rounds, final files, then invoice the rest. Some clients stay on a monthly retainer.</div>
      <div class="a-meta"><span class="prov">Your answer</span></div>
      <div class="card" style="margin-top:14px"><div class="meta mono" style="letter-spacing:.1em;text-transform:uppercase;font-size:10px;margin-bottom:8px">What I understood</div>
        <div class="diff-item"><span class="op add">+</span><div class="grow"><div>Service lines: Brand identity, Packaging, Retainer</div><span class="prov inferred" style="margin-top:4px">Inferred · confirm</span></div></div>
        <div class="diff-item"><span class="op add">+</span><div class="grow"><div>Project stages: Discovery → Proposal → Deposit → Concepts ×2 → Delivery → Final invoice</div><span class="prov inferred" style="margin-top:4px">Inferred · confirm</span></div></div>
      </div>
    </div>
  </div><div class="composer" style="background:var(--surface-1)"><div class="box">Type your answer…</div><button class="mic" aria-label="Answer by voice" data-act="toast:Voice answers use the device microphone — simulated in this prototype.">${ic('mic')}</button></div>
  <div style="padding:0 16px 14px;background:var(--surface-1)"><button class="btn btn-primary" data-go="data">Next question</button></div></section>`;

  V.data = () => {
    const src = (i, t, s, st, act) => `<div class="row"><span class="lead-ico">${ic(i)}</span><div class="grow"><div class="t">${t}</div><div class="s">${s}</div></div>${st}${act || ''}</div>`;
    return `<section class="screen">${sb()}${header('', 'interview')}${progress(3)}<div class="scroll" style="padding-top:16px">
      <h1 class="h-title">Add what you already have</h1><p class="muted" style="margin:6px 0 16px">Files are read once to propose a setup. You review every change before it’s saved.</p>
      <div class="list-sec">${src('file', 'clients.csv', '14 rows · 6 columns · uploaded', '<span class="pill ok">' + ic('check') + 'Read</span>')}${src('file', 'tasks.csv', '23 rows · 5 columns · uploaded', '<span class="pill ok">' + ic('check') + 'Read</span>')}${src('file', 'invoices.csv', 'Parsing… 61%', '<span class="pill warn">Reading</span>')}</div>
      <div class="h-sec"><h3>Add more</h3></div>
      <div class="list-sec">${src('upload', 'Upload a file', 'CSV, XLSX, PDF, DOCX · up to 25 MB', '', ic('right', 'style="width:18px;color:var(--text-3)"'))}${src('plug', 'Google Drive', 'Read-only folder import', '<span class="pill off">Not configured</span>')}${src('mail', 'Gmail', 'Contacts and threads', '<span class="pill off">Planned</span>')}</div>
      <p class="meta" style="margin-top:14px">Prototype: these files are sample fixtures; nothing is uploaded.</p>
    </div><div class="sticky-foot"><button class="btn btn-primary" data-go="mapping">Map fields</button></div></section>`;
  };

  V.mapping = () => {
    const r = (c, t, inf) => `<div class="map-row"><span class="col">${c}</span>${ic('right', 'style="width:16px;color:var(--text-3)"')}<button class="tgt" data-act="toast:Field picker opens here (prototype).">${t}${ic('down')}</button></div>${inf ? `<div style="padding:4px 0 2px"><span class="prov inferred">${inf}</span></div>` : ''}`;
    return `<section class="screen">${sb()}${header('clients.csv', 'data')}${progress(4)}<div class="scroll" style="padding-top:12px">
      <p class="muted" style="margin:0 0 6px">We matched 5 of 6 columns. Check the dashed ones.</p>
      ${r('Client Name', 'Client · Name')}${r('Contact Email', 'Contact · Email')}${r('Stage', 'Client · Status')}${r('Retainer ($)', 'Deal · Monthly value', 'Inferred from “$” values · confirm')}${r('Owner', 'Client · Owner (person)', 'Matched 3 of 4 names · confirm')}${r('Notes 2', 'Skip this column')}
      <div class="card" style="margin-top:14px"><div class="meta">Preview · row 1</div><div style="margin-top:6px;font-size:14px">Kestrel Coffee · ana@kestrel.example · Active · $4,800/mo · Ana Lim</div></div>
    </div><div class="sticky-foot"><button class="btn btn-primary" data-go="proposal">Build proposal</button></div></section>`;
  };

  V.proposal = () => {
    const it = (k, op, t, s, prov) => `<div class="diff-item"><span class="op ${op}">${op === 'add' ? '+' : op === 'mod' ? '~' : '−'}</span><div class="grow"><div style="font-size:15px">${t}</div><div class="meta" style="margin-top:2px">${s}</div>${prov ? `<div style="margin-top:6px">${prov}</div>` : ''}</div><button class="switch" role="switch" aria-checked="${S.proposal[k]}" aria-label="Include: ${esc(t)}" data-act="prop:${k}"></button></div>`;
    const n = Object.values(S.proposal).filter(Boolean).length;
    return `<section class="screen">${sb()}${header('Review setup', 'mapping')}${progress(5)}<div class="scroll" style="padding-top:12px">
      <p class="muted" style="margin:0">Nothing is saved until you apply. Turn off anything you don’t want.</p>
      <div class="diff-group"><div class="meta mono" style="font-size:10px;letter-spacing:.12em;text-transform:uppercase">Structure</div>
        ${it('dept', 'add', 'Department · Client Services', '2 people · Ana Lim, Jo Reyes', '<span class="prov inferred">Inferred from interview</span>')}
        ${it('rename', 'mod', 'Rename “Projects” → “Engagements”', 'Matches the words you used', '<span class="prov inferred">Inferred · optional</span>')}</div>
      <div class="diff-group"><div class="meta mono" style="font-size:10px;letter-spacing:.12em;text-transform:uppercase">Records</div>
        ${it('clients', 'add', '14 clients', 'clients.csv · 3 need review', '<span class="prov">From file</span>')}
        ${it('tasks', 'add', '23 tasks', 'tasks.csv · 4 overdue', '<span class="prov">From file</span>')}</div>
      <div class="diff-group"><div class="meta mono" style="font-size:10px;letter-spacing:.12em;text-transform:uppercase">Knowledge</div>
        ${it('sop', 'add', 'SOP · New client intake (7 steps)', 'Drafted by AI CEO from your answers', '<span class="prov inferred">AI draft · review</span>')}</div>
    </div><div class="sticky-foot"><button class="btn btn-primary" data-act="apply">Apply ${n} change${n === 1 ? '' : 's'}</button><p class="meta" style="text-align:center;margin:8px 0 0">You can undo this for 24 hours.</p></div></section>`;
  };

  V.home = () => {
    const pending = S.approvals.filter((a) => a.status === 'pending');
    if (S.homeEmpty) return `<section class="screen">${sb()}${topbar()}<div class="scroll">
      <h1 class="h-title" style="margin-top:8px">Good morning, Dan</h1><p class="muted" style="margin:4px 0 0">Your workspace is empty. Here’s where to start.</p>
      <div class="empty-cta" style="margin-top:18px"><div style="font-weight:600">Tell the AI CEO about your business</div><div class="muted" style="font-size:13px">A 5-minute interview creates a setup proposal you can review.</div><button class="btn btn-primary btn-sm" data-go="interview">Start interview</button></div>
      <div class="empty-cta" style="margin-top:10px"><div style="font-weight:600">Import clients or tasks</div><div class="muted" style="font-size:13px">CSV or spreadsheet. Nothing is saved until you approve.</div><button class="btn btn-secondary btn-sm" data-go="data">Upload a file</button></div>
    </div>${bnav('home')}</section>`;
    return `<section class="screen">${sb()}${topbar()}<div class="scroll">
      <h1 class="h-title" style="margin-top:8px">Good morning, Dan</h1><p class="muted" style="margin:4px 0 0">Sunday, Nov 15 · ${pending.length} waiting on you</p>
      ${pending.length ? `<button class="card" data-go="approvals" style="margin-top:16px;width:100%;text-align:left;border-color:color-mix(in srgb,var(--halo) 45%,var(--line));display:flex;gap:12px;align-items:center"><span class="lead-ico" style="color:var(--halo);background:var(--halo-soft)">${ic('shield')}</span><span class="grow" style="flex:1"><span style="display:block;font-weight:600">${pending.length} approval${pending.length > 1 ? 's' : ''} need you</span><span class="meta">${esc(pending[0].what)}</span></span>${ic('right', 'style="width:18px;color:var(--text-3)"')}</button>` : ''}
      <div class="h-sec"><h3>Today’s brief</h3><span class="meta">AI CEO · 7:00</span></div>
      <div class="card brief"><ul>
        <li><span>Alder &amp; Co. invoice ($2,400) is 2 days overdue. A reminder draft is waiting for approval.</span><span class="src">${ic('file')}invoices.csv · row 18</span></li>
        <li><span>Maren Dental proposal v2 is due today; Jo owns it.</span><span class="src">${ic('file')}tasks.csv · row 7</span></li>
        <li><span>3 imported clients have no owner yet.</span><span class="src">${ic('file')}clients.csv</span></li>
      </ul><div class="meta" style="margin-top:4px">Every line links to its source. No source, no claim.</div></div>
      <div class="h-sec"><h3>Numbers</h3></div>
      <div class="kpis">
        <div class="kpi"><div class="v">4</div><div class="l">Active clients</div><span class="src">From clients.csv</span></div>
        <div class="kpi"><div class="v">$2,400</div><div class="l">Overdue</div><span class="src">1 invoice · invoices.csv</span></div>
        <button class="kpi empty" data-go="integrations" style="grid-column:span 2"><div class="v">Revenue not available</div><div class="l">Connect finance data to see monthly revenue. We won’t estimate it.</div><span class="link" style="display:inline-block;margin-top:8px">Connect finance data</span></button>
      </div>
      <div class="h-sec"><h3>Due today</h3><a data-go="work">All tasks</a></div>
      <div class="list-sec">${S.tasks.filter((t) => t.tag === 'today').map(taskRow).join('')}</div>
    </div>${bnav('home')}</section>`;
  };
  function taskRow(t) {
    return `<div class="row spine" style="--spine:${t.late ? 'var(--bad)' : 'var(--line-strong)'};margin-left:0"><button class="check ${t.done ? 'done' : ''}" data-act="task:${t.id}" aria-label="${t.done ? 'Mark not done' : 'Mark done'}: ${esc(t.t)}">${t.done ? ic('check') : ''}</button><div class="grow"><div class="t" style="${t.done ? 'text-decoration:line-through;color:var(--text-3)' : ''}">${esc(t.t)}</div><div class="s">${t.late ? '<span style="color:var(--bad)">' + t.due + '</span>' : t.due} · ${PEOPLE[t.who]} · ${t.src}</div></div><span class="avatar" title="${PEOPLE[t.who]}">${t.who}</span></div>`;
  }

  V.live = () => {
    const a = AGENTS[S.agent];
    return `<section class="screen live" style="--agent:${a.hue}"><canvas class="core" id="lcore" aria-hidden="true"></canvas>
      ${sb()}<div class="top"><button class="icon-btn" data-go="home" aria-label="Close Live AI">${ic('x')}</button>
        <button class="agent-pick" data-act="sheet:agents" aria-label="Change agent, current ${a.name}"><span class="n"><span class="hue"></span>${a.name}${ic('down', 'style="width:14px;height:14px;color:var(--text-3)"')}</span><span class="c">${S.agent === 'ceo' ? 'Active · Assisted mode' : 'Template · not set up — preview only'}</span></button>
        <button class="icon-btn" aria-label="Run history" data-act="toast:Run history lists every action with its inputs and result (Phase 1).">${ic('history')}</button></div>
      <div class="rail" id="rail" aria-hidden="true"><span class="dt"></span><span class="ln"></span><span class="lbl" id="railLbl"></span><span class="ln"></span></div>
      <div class="hud" id="hud" aria-hidden="true"></div>
      <div class="live-body" id="liveBody"></div>
    </section>`;
  };
  const RAIL = { idle: ['Ready', '#ECE2CC'], listening: ['Listening', '#ECE2CC'], thinking: ['Thinking', '#ECE2CC'], tool: ['Working', '#F2B544'], approval: ['Needs approval', '#EBCB8B'], speaking: ['Speaking', '#ECE2CC'], success: ['Done', '#5BD69A'], error: ['Error', '#F2777A'], offline: ['Offline', '#7D8996'] };
  function renderLive() {
    const L = S.live, body = $('#liveBody'); if (!body) return;
    const st = L.micDenied && L.state === 'idle' ? 'idle' : L.state;
    const [lbl, col] = L.micDenied && L.state === 'idle' ? ['Mic off', '#7D8996'] : RAIL[st];
    $('#rail').style.setProperty('--railc', col); $('#railLbl').textContent = lbl;
    $('#hud').innerHTML = `Agent · ${AGENTS[S.agent].name}<br>Mode · Assisted<br>${L.sim ? '<span style="color:#EBCB8B">Simulated run</span>' : 'Prototype'}`;
    core.setState(st);
    let h = '<div class="live-scroll">';
    if (L.state === 'offline') h += `<div class="err-card" style="border-color:var(--line-strong);background:rgba(19,25,34,.9)"><div style="display:flex;gap:8px;align-items:center;font-weight:600">${ic('wifioff', 'style="width:18px;height:18px"')}You’re offline</div><div class="muted" style="margin-top:4px;font-size:13px">Messages will wait here and send when you reconnect. Nothing runs while offline.</div></div>`;
    if (L.micDenied && (L.state === 'idle')) h += `<div class="err-card" style="border-color:var(--line-strong);background:rgba(19,25,34,.9)"><div style="font-weight:600">Microphone access is off</div><div class="muted" style="margin:4px 0 10px;font-size:13px">Turn it on in Settings to talk, or type below.</div><div class="btn-row"><button class="btn btn-secondary btn-sm" data-act="toast:Opens iOS/Android settings (native only).">Open Settings</button><button class="btn btn-ghost btn-sm" data-act="focus-input">Type instead</button></div></div>`;
    if (L.utter) h += `<p class="utter ${L.state === 'listening' ? '' : 'dim'}">${esc(L.utter)}</p>`;
    if (L.state === 'listening') h += `<div class="state-note"><span class="rec-dot"></span>Listening — tap the mic to stop</div>`;
    if (L.state === 'thinking') h += `<div class="state-note">Thinking…</div>`;
    if (L.steps.length) h += `<details class="timeline" ${['thinking', 'tool'].includes(L.state) ? 'open' : ''}><summary><span>${L.steps.length} step${L.steps.length > 1 ? 's' : ''} · ${L.steps.filter((s) => s.st === 'done').length} done</span><span class="mono" style="font-size:10px;color:var(--text-3)">SIMULATED</span></summary>${L.steps.map((s) => `<div class="step ${s.st}"><span class="b"></span><span><code>${s.tool}</code> ${esc(s.d)}</span><span class="meta">${s.st === 'done' ? 'done' : s.st === 'run' ? 'running' : 'waiting'}</span></div>`).join('')}</details>`;
    if (L.appr) h += `<div class="appr-card" role="group" aria-label="Approval needed"><div class="rec" style="margin-bottom:6px">Needs your approval</div><div style="font-weight:600;font-size:15px">Create task: “Draft Q1 retainer offer for Kestrel Coffee”</div><div class="muted" style="font-size:13px;margin:4px 0 6px">Assign to Jo Reyes · due Fri, Nov 20 · internal only</div><div style="display:flex;gap:10px;align-items:center;margin-bottom:10px"><span class="risk low">${ic('shield')}Low risk</span><span class="meta">Reversible · no one is notified</span></div><div class="btn-row"><button class="btn btn-secondary btn-sm" style="flex:1" data-act="live-reject">Not now</button><button class="btn btn-primary btn-sm" style="flex:1.4" data-act="live-approve">Approve</button></div></div>`;
    if (L.state === 'error') h += `<div class="err-card"><div style="font-weight:600;color:var(--bad);display:flex;gap:6px;align-items:center">${ic('alert', 'style="width:16px;height:16px"')}The task tool didn’t respond</div><div class="muted" style="font-size:13px;margin:4px 0 10px">Nothing was changed. You can retry; the same request will run once.</div><div class="btn-row"><button class="btn btn-secondary btn-sm" data-act="live-retry">${ic('refresh')}Retry</button><button class="btn btn-ghost btn-sm" data-act="live-reset">Dismiss</button></div></div>`;
    if (L.resp) h += `<div class="resp">${L.resp.text}<div class="cites">${L.resp.cites.map((c) => `<span class="cite">${esc(c)}</span>`).join('')}</div><div class="resp-actions"><button class="icon-btn" aria-label="Copy">${ic('copy')}</button><button class="icon-btn" aria-label="Open run details" data-act="toast:Run details: inputs, tool calls, approvals and result (Phase 1).">${ic('eye')}</button></div></div>`;
    h += '</div>';
    if (L.state === 'idle' && !L.resp && !L.utter && !L.micDenied) h += `<div class="sugg">${['What needs me today?', 'Plan a Q1 retainer offer for Kestrel', 'Summarise overdue invoices'].map((q) => `<button class="chip" data-act="ask:${esc(q)}">${q}</button>`).join('')}</div>`;
    const busy = ['thinking', 'tool'].includes(L.state);
    h += `<div class="composer"><button class="icon-btn" aria-label="Attach file" data-act="toast:Attachments are read-only context for the agent (Phase 1).">${ic('clip')}</button><label class="box"><span class="sr-only">Message ${AGENTS[S.agent].name}</span><input id="liveIn" placeholder="${L.state === 'offline' ? 'Offline — will send later' : 'Ask ' + AGENTS[S.agent].name + '…'}" autocomplete="off"></label>
      ${busy ? `<button class="mic" aria-label="Stop run" data-act="live-stop">${ic('stop')}</button>` : `<button class="mic" id="micBtn" aria-pressed="${L.state === 'listening'}" aria-label="${L.state === 'listening' ? 'Stop listening' : 'Talk'}" data-act="mic">${ic(L.micDenied ? 'micoff' : 'mic')}</button>`}</div>`;
    body.innerHTML = h;
    const inp = $('#liveIn'); if (inp) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && inp.value.trim()) { runSim(inp.value.trim()); } });
    const sc = body.querySelector('.live-scroll'); if (sc) sc.scrollTop = sc.scrollHeight;
    renderNotes();
  }
  function setLive(patch) { Object.assign(S.live, patch); renderLive(); }
  function runSim(text) {
    clearTimers();
    if (S.live.state === 'offline') { toast('Queued. It will send when you’re back online (simulated).'); return; }
    setLive({ state: 'thinking', utter: text, steps: [], resp: null, appr: false, sim: true, err: false });
    later(() => setLive({ state: 'tool', steps: [{ tool: 'tasks.search', d: 'open tasks for Kestrel Coffee', st: 'run' }] }), 1300);
    later(() => setLive({ steps: [{ tool: 'tasks.search', d: '2 open tasks found', st: 'done' }, { tool: 'files.read', d: 'clients.csv · Kestrel Coffee', st: 'run' }] }), 2400);
    later(() => setLive({ state: 'approval', appr: true, steps: [{ tool: 'tasks.search', d: '2 open tasks found', st: 'done' }, { tool: 'files.read', d: 'retainer $4,800/mo since May', st: 'done' }, { tool: 'tasks.create', d: 'waiting for your approval', st: 'wait' }] }), 3500);
  }
  function approveSim() {
    clearTimers(); const steps = S.live.steps.map((s) => (s.st === 'wait' ? { ...s, st: 'run', d: 'creating task' } : s));
    setLive({ state: 'tool', appr: false, steps });
    later(() => setLive({ state: 'success', steps: steps.map((s) => ({ ...s, st: 'done', d: s.tool === 'tasks.create' ? 'task created · undo available' : s.d })), resp: { text: 'Done. I created “Draft Q1 retainer offer for Kestrel Coffee” for Jo, due Friday. Kestrel has been on a $4,800/mo retainer since May and has 2 open tasks.', cites: ['clients.csv · row 1', 'tasks.csv · rows 2, 9', 'Task T-0231'] } }), 900);
    later(() => setLive({ state: 'speaking' }), 2600);
    later(() => setLive({ state: 'idle' }), 5200);
  }

  V.approvals = () => {
    const pend = S.approvals.filter((a) => a.status === 'pending'), done = S.approvals.filter((a) => a.status !== 'pending');
    const card = (a) => `<button class="card appr" data-act="appr:${a.id}" style="text-align:left;width:100%"><div style="display:flex;justify-content:space-between;align-items:center">${agentChip(a.agent)}<span class="risk ${a.risk}">${ic(a.risk === 'low' ? 'shield' : 'alert')}${riskLbl[a.risk]}</span></div><div class="what">${esc(a.what)}</div><div class="meta">${a.kind} · ${esc(a.target)}</div></button>`;
    return `<section class="screen">${sb()}${header('Approvals', 'home')}<div class="scroll">
      <p class="muted" style="margin:0 0 14px">Agents can draft anything. They can’t send, pay, delete or share without you.</p>
      ${pend.length ? `<div class="stack">${pend.map(card).join('')}</div>` : `<div class="empty-cta"><div style="font-weight:600">You’re all caught up</div><div class="muted" style="font-size:13px">New requests from agents will appear here.</div></div>`}
      ${done.length ? `<div class="h-sec"><h3>Decided</h3></div><div class="list-sec">${done.map((a) => `<div class="row"><span class="lead-ico">${ic(a.status === 'approved' ? 'check' : 'x')}</span><div class="grow"><div class="t">${esc(a.what)}</div><div class="s">${a.status === 'approved' ? 'Approved · simulated' : 'Declined'} · just now</div></div></div>`).join('')}</div>` : ''}
    </div></section>`;
  };

  V.approval = () => {
    const a = S.approvals.find((x) => x.id === S.apprId) || S.approvals[0];
    return `<section class="screen">${sb()}${header('Approval', 'approvals')}<div class="scroll">
      <div style="display:flex;justify-content:space-between;align-items:center">${agentChip(a.agent)}<span class="risk ${a.risk}">${ic(a.risk === 'low' ? 'shield' : 'alert')}${riskLbl[a.risk]}</span></div>
      <h1 class="h-title" style="margin:10px 0 4px">${esc(a.what)}</h1><div class="meta">${a.kind} · to ${esc(a.target)}</div>
      <div class="h-sec"><h3>Why</h3></div><p style="margin:0;font-size:15px">${esc(a.why)}</p>
      <div class="h-sec"><h3>Exactly what will happen</h3><button class="link" data-act="toast:Editing opens the draft before approval (prototype).">Edit</button></div>
      <div class="card" style="font-size:14px">${esc(a.preview)}</div>
      <div class="h-sec"><h3>Sources</h3></div><div class="chips" style="flex-wrap:wrap">${a.src.map((s) => `<span class="prov">${ic('file', 'style="width:12px;height:12px"')}${esc(s)}</span>`).join('')}</div>
      <div class="card" style="margin-top:14px;display:flex;gap:10px"><span style="color:var(--text-2)">${ic('info', 'style="width:18px;height:18px"')}</span><span class="muted" style="font-size:13px">${a.risk === 'med' ? 'An email can’t be unsent. Gmail isn’t connected in this prototype, so approving here only simulates the send.' : 'Reversible for 24 hours from the activity log.'}</span></div>
    </div>${a.status === 'pending' ? `<div class="sticky-foot"><div class="btn-row"><button class="btn btn-secondary" data-act="decide:${a.id}:declined">Decline</button><button class="btn btn-primary" style="flex:1.4" data-act="decide:${a.id}:approved">${a.risk === 'med' ? 'Approve & send' : 'Approve'}</button></div></div>` : `<div class="sticky-foot"><div class="pill ${a.status === 'approved' ? 'ok' : 'off'}" style="justify-content:center;width:100%">${a.status === 'approved' ? 'Approved · simulated' : 'Declined'}</div></div>`}</section>`;
  };

  V.work = () => {
    const tab = S.workTab, list = S.tasks.filter((t) => t.tag === tab);
    return `<section class="screen">${sb()}${topbar()}<div style="padding:0 16px 10px"><h1 class="h-title" style="margin:4px 0 12px">Work</h1>
      <div class="seg" role="tablist">${[['today', 'Today'], ['upcoming', 'Upcoming'], ['done', 'Done']].map(([k, l]) => `<button role="tab" aria-selected="${tab === k}" data-act="worktab:${k}">${l}</button>`).join('')}</div></div>
      <div class="scroll">${list.length ? `<div class="list-sec">${list.map(taskRow).join('')}</div>` : '<div class="empty-cta"><div style="font-weight:600">Nothing here</div><div class="muted" style="font-size:13px">Tasks you or your agents create will show up here.</div></div>'}
      <div class="h-sec"><h3>Projects</h3><span class="meta">3 · from import</span></div>
      <div class="list-sec">${[['Kestrel Coffee — Packaging refresh', 'Concepts round 2 · 6 of 11 tasks'], ['Maren Dental — Identity', 'Proposal · 1 of 4 tasks'], ['Alder & Co. — Retainer', 'Ongoing · monthly']].map(([t, s]) => `<div class="row"><span class="lead-ico">${ic('work')}</span><div class="grow"><div class="t">${t}</div><div class="s">${s}</div></div>${ic('right', 'style="width:18px;color:var(--text-3)"')}</div>`).join('')}</div>
      </div><button class="fab" aria-label="New task" data-act="toast:New task sheet (prototype).">${ic('plus')}</button>${bnav('work')}</section>`;
  };

  V.workforce = () => `<section class="screen">${sb()}${header('AI workforce', 'business')}<div class="scroll">
    <p class="muted" style="margin:0 0 14px">One agent is active. The others are templates — set them up when you’re ready; each starts in Assisted mode.</p>
    <div class="agent-grid">${Object.entries(AGENTS).map(([k, a]) => `<button class="agent-tile ${k === 'ceo' ? '' : 'unset'}" style="--h:${a.hue}" data-act="agent:${k}"><span class="presence"></span><span><span class="an" style="display:block">${a.name}</span><span class="ar">${a.role}</span></span>${k === 'ceo' ? '<span class="pill ok">' + ic('check') + 'Active</span>' : '<span class="pill off">Template · Set up</span>'}</button>`).join('')}</div>
    <p class="meta" style="margin-top:14px">Colours identify agents only. Gold is reserved for things that need you.</p>
  </div></section>`;

  V.agent = () => {
    const k = S.agent, a = AGENTS[k], live = k === 'ceo';
    return `<section class="screen" style="--agent:${a.hue}">${sb()}${header('', 'workforce', '<button class="icon-btn" aria-label="More">' + ic('more') + '</button>')}<div class="scroll">
      <div style="display:flex;gap:14px;align-items:center"><span class="presence" style="--h:${a.hue};width:64px;height:64px;${live ? '' : 'filter:saturate(.35) brightness(.8)'}"></span><div><h1 class="h-title">${a.name}</h1><div class="meta">${a.role}</div><div style="margin-top:6px">${live ? '<span class="pill ok">' + ic('check') + 'Active · Assisted</span>' : '<span class="pill off">Template · not set up</span>'}</div></div></div>
      <div class="seg" role="tablist" style="margin-top:18px">${[['about', 'About'], ['perms', 'Permissions'], ['activity', 'Activity']].map(([t, l]) => `<button role="tab" aria-selected="${S.agentTab === t}" data-act="agenttab:${t}">${l}</button>`).join('')}</div>
      ${S.agentTab === 'about' ? `<div class="h-sec"><h3>Autonomy</h3></div><div class="list-sec">${[['Observe', 'Reads and summarises only'], ['Assisted', 'Drafts; every action needs approval'], ['Delegated', 'Low-risk internal actions run; others ask']].map(([t, s], i) => `<div class="row"><div class="grow"><div class="t">${t}</div><div class="s">${s}</div></div>${i === 1 ? '<span class="pill ok">' + ic('check') + 'Current</span>' : i === 2 ? '<span class="pill off">Locked · Phase 2</span>' : ''}</div>`).join('')}</div>
        <div class="h-sec"><h3>Responsibilities</h3></div><div class="card muted" style="font-size:14px">${live ? 'Daily brief, triage of incoming work, cross-team planning, and drafting messages for your approval.' : 'Template description. Setting up asks which data it may read and which actions it may propose.'}</div>
        ${live ? '' : '<button class="btn btn-primary" style="margin-top:16px" data-act="toast:Agent setup flow — Phase 1.">Set up ' + a.name + '</button>'}` : ''}
      ${S.agentTab === 'perms' ? `<div class="perm"><h5 style="color:var(--ok)">${ic('eye')}Can read</h5><ul><li>tasks.*<span>${live ? 'on' : '—'}</span></li><li>clients.*<span>${live ? 'on' : '—'}</span></li><li>files (Library)<span>${live ? 'on' : '—'}</span></li></ul>
        <h5 style="color:var(--halo)">${ic('shield')}Asks before</h5><ul><li>tasks.create / update<span>always</span></li><li>email.send<span>always</span></li><li>clients.update<span>always</span></li></ul>
        <h5 style="color:var(--bad)">${ic('lock')}Never</h5><ul><li>payments.*<span>blocked</span></li><li>members.invite / remove<span>blocked</span></li><li>data.delete_bulk<span>blocked</span></li></ul></div>` : ''}
      ${S.agentTab === 'activity' ? (live ? `<div class="list-sec" style="margin-top:14px">${[['Drafted invoice reminder', 'Waiting for approval · 7:02'], ['Posted daily brief', '3 sources · 7:00'], ['Read clients.csv', '14 rows · yesterday']].map(([t, s]) => `<div class="row"><div class="grow"><div class="t">${t}</div><div class="s">${s}</div></div></div>`).join('')}</div><p class="meta" style="margin-top:10px">Sample activity.</p>` : '<div class="empty-cta" style="margin-top:14px"><div class="muted">No activity — this agent isn’t set up.</div></div>') : ''}
    </div></section>`;
  };

  V.business = () => {
    const tile = (go, i, t, s) => `<button class="row" data-go="${go}" style="width:100%;text-align:left"><span class="lead-ico">${ic(i)}</span><div class="grow"><div class="t">${t}</div><div class="s">${s}</div></div>${ic('right', 'style="width:18px;color:var(--text-3)"')}</button>`;
    return `<section class="screen">${sb()}${topbar()}<div class="scroll"><h1 class="h-title" style="margin:4px 0 4px">Business</h1><p class="muted" style="margin:0 0 14px">Everything Harbor &amp; Pine runs on.</p>
      <div class="list-sec">${tile('workforce', 'users', 'AI workforce', '1 active · 5 templates')}${tile('crm', 'user', 'Clients', '4 clients · 1 overdue')}${tile('automation', 'flow', 'Automation', '1 draft · 0 running')}</div>
      <div class="h-sec"><h3>Workspace</h3></div>
      <div class="list-sec">${tile('integrations', 'plug', 'Integrations', 'Nothing connected yet')}${tile('settings', 'sliders', 'Settings', 'Members, AI policy, data')}</div>
      <div class="h-sec"><h3>Departments</h3><span class="meta">from setup</span></div>
      <div class="list-sec">${[['Client Services', 'Ana, Jo · 2 projects'], ['Studio', 'Mika · design production'], ['Admin & Finance', 'Dan · invoices, contracts']].map(([t, s]) => `<div class="row"><div class="grow"><div class="t">${t}</div><div class="s">${s}</div></div></div>`).join('')}</div>
    </div>${bnav('business')}</section>`;
  };

  V.crm = () => `<section class="screen">${sb()}${header('Clients', 'business', '<button class="icon-btn" aria-label="Search clients">' + ic('search') + '</button>')}<div class="scroll">
    <div class="chips" style="margin-bottom:10px">${['All 4', 'Active', 'Proposal', 'Leads'].map((c, i) => `<span class="chip" aria-pressed="${i === 0}">${c}</span>`).join('')}</div>
    <div class="list-sec">${CLIENTS.map((c) => `<div class="row spine" style="--spine:var(--${c.st === 'off' ? 'line-strong' : c.st})"><span class="avatar" style="border-radius:10px">${c.n.split(' ').map((w) => w[0]).slice(0, 2).join('')}</span><div class="grow"><div class="t">${c.n}</div><div class="s">${c.s}</div></div><span class="meta mono" style="font-size:12px">${c.v}</span></div>`).join('')}</div>
    <p class="meta" style="margin-top:12px">Values come from clients.csv. “est.” is the proposal amount, not revenue.</p>
  </div><button class="fab" aria-label="Add client" data-act="toast:Add client sheet (prototype).">${ic('plus')}</button></section>`;

  V.library = () => {
    const t = S.libTab;
    const rows = { docs: [['file', 'New client intake', 'SOP · AI draft · needs review', '<span class="prov inferred">Draft</span>'], ['file', 'Brand guidelines template', 'Doc · uploaded Nov 2', ''], ['file', 'Maren Dental proposal v1', 'PDF · 6 pages', '']], files: [['file', 'clients.csv', 'Imported · 14 rows', '<span class="prov">Source</span>'], ['file', 'tasks.csv', 'Imported · 23 rows', '<span class="prov">Source</span>'], ['file', 'invoices.csv', 'Imported · 31 rows', '<span class="prov">Source</span>']], memory: [['book', 'Deposit is always 50%', 'From interview · Nov 15', '<span class="prov verified">Confirmed</span>'], ['book', 'Two concept rounds per project', 'From interview · Nov 15', '<span class="prov inferred">Inferred</span>']] }[t];
    return `<section class="screen">${sb()}${topbar()}<div style="padding:0 16px 10px"><h1 class="h-title" style="margin:4px 0 12px">Library</h1><div class="seg" role="tablist">${[['docs', 'Docs & SOPs'], ['files', 'Files'], ['memory', 'Memory']].map(([k, l]) => `<button role="tab" aria-selected="${t === k}" data-act="libtab:${k}">${l}</button>`).join('')}</div></div>
      <div class="scroll"><div class="list-sec">${rows.map(([i, a, b, c]) => `<div class="row"><span class="lead-ico">${ic(i)}</span><div class="grow"><div class="t">${a}</div><div class="s">${b}</div></div>${c}</div>`).join('')}</div>
      ${t === 'memory' ? '<p class="meta" style="margin-top:12px">Agents only use memory you can see here. Delete anything, any time.</p>' : ''}</div>${bnav('library')}</section>`;
  };

  V.automation = () => `<section class="screen">${sb()}${header('Overdue invoice reminder', 'business', '<span class="pill off" style="margin-right:10px">Draft</span>')}<div class="scroll">
    <div class="flow">
      <div class="node"><span class="lead-ico">${ic('cal')}</span><div><div class="k">Trigger</div><div class="v">Every weekday at 9:00</div></div></div><div class="conn"></div>
      <div class="node"><span class="lead-ico">${ic('search')}</span><div><div class="k">Find</div><div class="v">Invoices overdue 2+ days</div></div></div><div class="conn"></div>
      <div class="node"><span class="lead-ico">${ic('edit')}</span><div><div class="k">AI CEO drafts</div><div class="v">Reminder email per client</div></div></div><div class="conn"></div>
      <div class="node approval"><span class="lead-ico" style="color:var(--halo);background:var(--halo-soft)">${ic('shield')}</span><div><div class="k" style="color:var(--halo)">Approval</div><div class="v">You approve each email</div></div></div><div class="conn"></div>
      <div class="node fail"><span class="lead-ico">${ic('mail')}</span><div style="flex:1"><div class="k">Send</div><div class="v">Gmail · not connected</div></div><span class="pill warn">Blocked</span></div>
    </div>
    <div class="card" style="margin-top:16px;display:flex;gap:10px"><span style="color:var(--warn)">${ic('alert', 'style="width:18px;height:18px"')}</span><span class="muted" style="font-size:13px">This automation can’t run until Gmail is connected. Test runs use sample data and never send.</span></div>
  </div><div class="sticky-foot"><div class="btn-row"><button class="btn btn-secondary" data-act="toast:Test run on sample data: 1 draft created, 0 sent (simulated).">Test run</button><button class="btn btn-primary" data-go="integrations">Connect Gmail</button></div></div></section>`;

  V.integrations = () => {
    const r = (i, t, s, st) => `<div class="row"><span class="lead-ico">${ic(i)}</span><div class="grow"><div class="t">${t}</div><div class="s">${s}</div></div>${st}</div>`;
    return `<section class="screen">${sb()}${header('Integrations', 'business')}<div class="scroll">
      <p class="muted" style="margin:0 0 14px">Each connection asks for the narrowest access. Statuses here are real for this prototype: nothing is connected.</p>
      <div class="h-sec" style="margin-top:0"><h3>Phase 1</h3></div>
      <div class="list-sec">${r('plug', 'Google Drive', 'Read files for import', '<button class="btn btn-secondary btn-sm" data-act="toast:Needs a registered Google OAuth app — owner approval required.">Connect</button>')}${r('mail', 'Gmail', 'Draft and send with approval', '<span class="pill off">Not configured</span>')}${r('cal', 'Google Calendar', 'Read availability', '<span class="pill off">Not configured</span>')}</div>
      <div class="h-sec"><h3>Planned</h3></div>
      <div class="list-sec">${r('dollar', 'Stripe', 'Revenue and invoices · read-only', '<span class="pill off">Planned</span>')}${r('chart', 'QuickBooks / Xero', 'Accounting · read-only', '<span class="pill off">Planned</span>')}${r('users', 'Slack', 'Notifications and briefs', '<span class="pill off">Planned</span>')}</div>
    </div></section>`;
  };

  V.settings = () => {
    const r = (t, s, right) => `<div class="row"><div class="grow"><div class="t">${t}</div><div class="s">${s}</div></div>${right || ic('right', 'style="width:18px;color:var(--text-3)"')}</div>`;
    return `<section class="screen">${sb()}${header('Settings', 'business')}<div class="scroll">
      <div class="h-sec" style="margin-top:0"><h3>Workspace</h3></div><div class="list-sec">${r('Members', '4 people · 1 owner, 3 members')}${r('Currency & region', 'USD · America/Los_Angeles')}${r('Data export', 'Download everything as CSV + JSON')}</div>
      <div class="h-sec"><h3>AI policy</h3></div><div class="list-sec">${r('Default autonomy', 'Assisted — every action asks', '<span class="meta">Assisted</span>')}${r('Approval for external messages', 'Always required · can’t be turned off', '<span class="pill">' + ic('lock') + 'Locked</span>')}${r('Spending limit', '$0 — agents can’t spend', '<span class="meta">$0</span>')}</div>
      <div class="h-sec"><h3>Appearance</h3></div><div class="list-sec">${r('Theme', S.theme === 'dark' ? 'Dark' : 'Light', `<button class="switch" role="switch" aria-checked="${S.theme === 'dark'}" aria-label="Dark theme" data-act="theme"></button>`)}${r('Reduce motion', 'Static energy core, no slides', `<button class="switch" role="switch" aria-checked="${S.reduce}" aria-label="Reduce motion" data-act="reduce"></button>`)}</div>
      <button class="btn btn-danger" style="margin-top:18px" data-act="toast:Deleting a workspace needs typed confirmation and a 7-day grace period.">Delete workspace</button>
    </div></section>`;
  };

  // sheets
  const SHEETS = {
    switcher: () => `<div class="grab"></div><h2 class="h-title" style="font-size:18px;margin-bottom:8px">Workspaces</h2>
      <div class="list-sec"><div class="row"><span class="ws-chip">${WS.short}</span><div class="grow"><div class="t">${WS.name}</div><div class="s">${WS.meta}</div></div><span class="pill ok">${ic('check')}Current</span></div>
      <div class="row"><span class="ws-chip" style="background:#3A2E4A;color:#D9CCF5">SJ</span><div class="grow"><div class="t">Sajonia Personal</div><div class="s">1 person · PHP · empty</div></div></div></div>
      <button class="btn btn-secondary" style="margin-top:12px" data-act="toast:Create workspace runs onboarding again (prototype).">${ic('plus')}New workspace</button>
      <p class="meta" style="margin-top:10px">Data never crosses workspaces. Each has its own agents and approvals.</p>`,
    agents: () => `<div class="grab"></div><h2 class="h-title" style="font-size:18px;margin-bottom:8px">Talk to</h2><div class="list-sec">${Object.entries(AGENTS).map(([k, a]) => `<button class="row" style="width:100%;text-align:left" data-act="pick:${k}"><span class="presence" style="--h:${a.hue};width:36px;height:36px;${k === 'ceo' ? '' : 'filter:saturate(.35) brightness(.8)'}"></span><div class="grow"><div class="t">${a.name}</div><div class="s">${k === 'ceo' ? 'Active' : 'Template · preview only'}</div></div>${S.agent === k ? '<span class="pill ok">' + ic('check') + '</span>' : ''}</button>`).join('')}</div>`,
  };

  // ───────── board panels ─────────
  const NOTES = {
    welcome: ['First impression. The energy core is the only animated element.', ['Core uses the AI CEO hue', 'Respects reduced motion (static frame)']],
    signin: ['Email + password, plus Google.', ['Social sign-in buttons are not wired — shown as planned', 'Better Auth handles sessions (docs/04)']],
    mode: ['User picks how to set up. Hybrid is recommended, not forced.', ['Nothing is written until the proposal is approved']],
    interview: ['Adaptive interview with live “what I understood”.', ['Inferred facts are dashed and must be confirmed', 'Skip is always available']],
    data: ['Import from files or sources.', ['Drive/Gmail show honest statuses', 'Parsing runs as a background job (pg-boss)']],
    mapping: ['Column → field mapping with confidence.', ['Low-confidence matches are marked Inferred']],
    proposal: ['Setup proposal as a reviewable diff.', ['Every item can be toggled off', 'Apply is reversible for 24h']],
    home: ['Daily command surface: approvals first, brief with sources, real numbers only.', ['Revenue shows an empty state instead of an estimate', 'Toggle the empty workspace state below']],
    live: ['Immersive Live AI. Always dark. One agent, one living signal.', ['Type or tap a suggestion to start a simulated run', 'Approval card uses Halo gold; agents never do', 'State rail on the left names the state in words']],
    approvals: ['Queue of agent requests needing a human.', ['Risk is shown with icon + word, not colour alone']],
    approval: ['Full context before deciding: why, exact payload, sources, reversibility.', ['External sends say clearly that they’re simulated here']],
    work: ['Tasks and projects. Overdue uses the red status spine.', ['Tap a circle to complete a task']],
    workforce: ['Agents as a visible team.', ['Only the AI CEO is active; others are templates', 'Hues identify agents; gold stays for humans']],
    agent: ['Agent profile: autonomy, permissions, activity.', ['Permissions are tiered: read / ask / never', 'Delegated mode is locked until Phase 2']],
    business: ['Hub for structure, clients, automation and settings.', []],
    crm: ['Lightweight clients list from import.', ['Status spine colour + text', 'Values sourced; estimates labelled']],
    library: ['Docs, files and visible memory.', ['Memory is inspectable and deletable']],
    automation: ['Automation as a readable step list with a mandatory approval step.', ['Blocked step shown honestly (Gmail not connected)']],
    integrations: ['Integration catalogue with real statuses.', ['Nothing is connected; Connect explains what’s needed']],
    settings: ['Workspace, AI policy and appearance.', ['External-message approval is locked on']],
  };
  function renderNav() {
    $('#boardNav').innerHTML = `<button class="btn btn-secondary btn-sm close-nav" style="float:right" data-board="closenav">Close</button>
      <div class="brand">${LOGO}<b>Qline</b></div><p class="board-sub">Phase 0 · clickable design prototype</p>
      <div class="honest">Sample workspace and simulated runs. No backend, no accounts, no integrations are connected.</div>
      ${SCREENS.map((g) => `<div class="nav-group"><h3>${g.g}</h3>${g.items.map(([k, t, n]) => `<button data-go="${k}" ${S.screen === k ? 'aria-current="true"' : ''}><span>${t}</span><span>${n}</span></button>`).join('')}</div>`).join('')}
      <div class="nav-group"><h3>Sheets</h3><button data-board="switcher"><span>Workspace switcher</span><span>S1</span></button></div>
      <div class="toggles"><button class="toggle" aria-pressed="${S.theme === 'light'}" data-act="theme">Theme <i>${S.theme}</i></button><button class="toggle" aria-pressed="${S.reduce}" data-act="reduce">Reduce motion <i>${S.reduce ? 'on' : 'off'}</i></button></div>`;
  }
  function renderNotes() {
    const el = $('#notes'); const [p, list] = NOTES[S.screen] || ['', []]; const meta = TITLES[S.screen] || { t: '', n: '' };
    let h = `<div class="id">SCREEN ${meta.n}</div><h2>${meta.t}</h2><p>${p}</p>${list.length ? `<ul>${list.map((x) => `<li>${x}</li>`).join('')}</ul>` : ''}`;
    if (S.screen === 'live') {
      h += `<h4>Agent</h4><div class="ctl-grid">${Object.entries(AGENTS).map(([k, a]) => `<button class="ctl" aria-pressed="${S.agent === k}" data-act="pick:${k}"><span class="dot" style="background:${a.hue}"></span>${a.name}</button>`).join('')}</div>
        <h4>Preview state</h4><div class="ctl-grid">${['idle', 'listening', 'thinking', 'tool', 'approval', 'speaking', 'success', 'error', 'offline'].map((s) => `<button class="ctl" aria-pressed="${S.live.state === s && !S.live.micDenied}" data-act="pstate:${s}">${RAIL[s][0]}</button>`).join('')}<button class="ctl" aria-pressed="${S.live.micDenied}" data-act="pstate:micdenied">Mic denied</button></div>
        <p style="margin-top:10px">Or type in the composer to watch a full simulated run.</p>`;
    }
    if (S.screen === 'home') h += `<h4>Variant</h4><div class="ctl-grid"><button class="ctl" aria-pressed="${!S.homeEmpty}" data-act="home:full">Imported data</button><button class="ctl" aria-pressed="${S.homeEmpty}" data-act="home:empty">Empty workspace</button></div>`;
    h += `<h4>References</h4><div class="refs">${[['ref_main', 'FounderOS board (primary)'], ['ss_213907', 'Reel · listening'], ['ss_213930', 'Reel · processing'], ['ss_213933', 'Reel · listening alt']].map(([f, c]) => `<figure><a href="refs/${f}.jpg" target="_blank" rel="noopener"><img src="refs/${f}.jpg" alt="${c}" loading="lazy"></a><figcaption>${c}</figcaption></figure>`).join('')}</div>
      <p style="font-size:11px;margin-top:8px">Used for layout and mood only. Reel art is third-party and not copied.</p>`;
    el.innerHTML = h;
    $('#barTitle').textContent = `${meta.n} · ${meta.t}`;
  }

  // ───────── render / routing ─────────
  const app = $('#app');
  function render() {
    app.dataset.theme = S.theme; app.classList.toggle('reduce', S.reduce);
    app.style.setProperty('--agent', AGENTS[S.agent].hue);
    let h = (V[S.screen] || V.home)();
    if (S.sheet) h += `<div class="sheet-backdrop" data-act="closesheet"></div><div class="sheet" role="dialog" aria-modal="true">${SHEETS[S.sheet]()}</div>`;
    if (S.toast) h += `<div class="toast" role="status">${ic('info')}<span>${esc(S.toast)}</span></div>`;
    app.innerHTML = h;
    core.setReduce(S.reduce); welcomeCore.setReduce(S.reduce);
    if (S.screen === 'live') { core.attach($('#lcore'), { cy: .44 }); core.setAgent(S.agent); renderLive(); } else core.detach();
    if (S.screen === 'welcome') welcomeCore.attach($('#wcore'), { cy: .3, compact: true }); else welcomeCore.detach();
    renderNav(); if (S.screen !== 'live') renderNotes();
  }
  function go(k) {
    if (S.screen === 'live' && k !== 'live') { clearTimers(); S.live = { ...S.live, state: S.live.state === 'offline' ? 'offline' : 'idle', utter: '', steps: [], resp: null, appr: false, sim: false }; }
    S.screen = k; S.sheet = null; S.toast = null; if (location.hash !== '#' + k) history.replaceState(null, '', '#' + k);
    $('#boardNav').classList.remove('open'); $('#openNav').setAttribute('aria-expanded', 'false');
    render(); const sc = app.querySelector('.scroll'); if (sc) sc.scrollTop = 0;
  }
  let toastT;
  function toast(m) { S.toast = m; clearTimeout(toastT); toastT = setTimeout(() => { S.toast = null; const t = app.querySelector('.toast'); if (t) t.remove(); }, 3200);
    const old = app.querySelector('.toast'); if (old) old.remove(); app.insertAdjacentHTML('beforeend', `<div class="toast" role="status">${ic('info')}<span>${esc(m)}</span></div>`); }

  function act(a) {
    const [k, ...rest] = a.split(':'); const v = rest.join(':');
    switch (k) {
      case 'toast': return toast(v);
      case 'sheet': S.sheet = v; return render();
      case 'closesheet': S.sheet = null; return render();
      case 'mode': S.mode = v; return render();
      case 'prop': S.proposal[v] = !S.proposal[v]; return render();
      case 'apply': S.homeEmpty = false; go('home'); return toast('Setup applied to the sample workspace (simulated). Undo available for 24 hours.');
      case 'task': { const t = S.tasks.find((x) => x.id === v); t.done = !t.done; return render(); }
      case 'worktab': S.workTab = v; return render();
      case 'libtab': S.libTab = v; return render();
      case 'agenttab': S.agentTab = v; return render();
      case 'agent': S.agent = v; S.agentTab = 'about'; return go('agent');
      case 'appr': S.apprId = v; return go('approval');
      case 'decide': { const [id, st] = v.split(':'); S.approvals.find((x) => x.id === id).status = st; go('approvals'); return toast(st === 'approved' ? 'Approved. Simulated — nothing was actually sent.' : 'Declined. The agent won’t retry this.'); }
      case 'theme': S.theme = S.theme === 'dark' ? 'light' : 'dark'; return render();
      case 'reduce': S.reduce = !S.reduce; return render();
      case 'home': S.homeEmpty = v === 'empty'; return render();
      case 'pick': S.agent = v; S.sheet = null; if (S.screen === 'live') { app.style.setProperty('--agent', AGENTS[v].hue); render(); } else render(); return;
      case 'ask': return runSim(v);
      case 'live-approve': return approveSim();
      case 'live-reject': clearTimers(); return setLive({ state: 'idle', appr: false, steps: S.live.steps.map((s) => (s.st === 'wait' ? { ...s, st: 'done', d: 'declined — not created' } : s)), resp: { text: 'Okay — I didn’t create it. Nothing changed.', cites: [] } });
      case 'live-stop': clearTimers(); return setLive({ state: 'idle', steps: S.live.steps.map((s) => (s.st === 'run' ? { ...s, st: 'done', d: 'stopped by you' } : s)), resp: { text: 'Stopped. No changes were made.', cites: [] } });
      case 'live-retry': return runSim(S.live.utter || 'Plan a Q1 retainer offer for Kestrel');
      case 'live-reset': clearTimers(); return setLive({ state: 'idle', utter: '', steps: [], resp: null, appr: false, sim: false });
      case 'focus-input': { const i = $('#liveIn'); if (i) i.focus(); return; }
      case 'mic': {
        if (S.live.micDenied) return toast('Microphone access is off. Turn it on in Settings, or type.');
        if (S.live.state === 'listening') { clearTimers(); return runSim(S.live.utter || 'What needs me today?'); }
        clearTimers(); setLive({ state: 'listening', utter: '', steps: [], resp: null, appr: false, sim: true });
        const words = 'Plan a Q1 retainer offer for Kestrel Coffee'.split(' ');
        words.forEach((w, i) => later(() => { if (S.live.state === 'listening') setLive({ utter: words.slice(0, i + 1).join(' ') }); }, 450 + i * 330));
        later(() => { if (S.live.state === 'listening') runSim(S.live.utter); }, 450 + words.length * 330 + 900);
        return;
      }
      case 'pstate': {
        clearTimers(); const base = { utter: '', steps: [], resp: null, appr: false, micDenied: false, sim: false };
        const presets = {
          idle: {}, listening: { utter: 'Plan a Q1 retainer offer for' }, thinking: { utter: 'Plan a Q1 retainer offer for Kestrel Coffee' },
          tool: { utter: 'Plan a Q1 retainer offer for Kestrel Coffee', steps: [{ tool: 'tasks.search', d: 'open tasks for Kestrel Coffee', st: 'run' }] },
          approval: { utter: 'Plan a Q1 retainer offer for Kestrel Coffee', appr: true, steps: [{ tool: 'tasks.search', d: '2 open tasks found', st: 'done' }, { tool: 'tasks.create', d: 'waiting for your approval', st: 'wait' }] },
          speaking: { resp: { text: 'You have 2 tasks due today and one overdue invoice from Alder & Co. The reminder draft is waiting in Approvals.', cites: ['tasks.csv', 'invoices.csv · row 18'] } },
          success: { resp: { text: 'Done. Task created for Jo, due Friday.', cites: ['Task T-0231'] }, steps: [{ tool: 'tasks.create', d: 'task created · undo available', st: 'done' }] },
          error: { utter: 'Plan a Q1 retainer offer for Kestrel Coffee', steps: [{ tool: 'tasks.search', d: 'timed out after 10s', st: 'done' }] },
          offline: {},
        };
        if (v === 'micdenied') return setLive({ ...base, state: 'idle', micDenied: true });
        return setLive({ ...base, state: v, ...presets[v] });
      }
    }
  }

  document.addEventListener('click', (e) => {
    const g = e.target.closest('[data-go]'); if (g) { e.preventDefault(); return go(g.dataset.go); }
    const a = e.target.closest('[data-act]'); if (a) { e.preventDefault(); return act(a.dataset.act); }
    const b = e.target.closest('[data-board]');
    if (b) { if (b.dataset.board === 'closenav') { $('#boardNav').classList.remove('open'); $('#openNav').setAttribute('aria-expanded', 'false'); } if (b.dataset.board === 'switcher') { if (!['home', 'work', 'business', 'library'].includes(S.screen)) S.screen = 'home'; S.sheet = 'switcher'; $('#boardNav').classList.remove('open'); render(); } }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.sheet) { S.sheet = null; render(); } });
  $('#openNav').addEventListener('click', () => { $('#boardNav').classList.add('open'); $('#openNav').setAttribute('aria-expanded', 'true'); });
  $('#barTheme').addEventListener('click', () => act('theme'));
  window.addEventListener('resize', () => { core.resize(); welcomeCore.resize(); core.kick(); welcomeCore.kick(); });
  window.addEventListener('hashchange', () => { const k = location.hash.slice(1); if (TITLES[k] && k !== S.screen) go(k); });

  const start = location.hash.slice(1); if (TITLES[start]) S.screen = start;
  render();
})();
