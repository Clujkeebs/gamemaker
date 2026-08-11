// Rumpus editor.
//
// Holds one game at a time: a template id, a config, and the copy around it.
// The preview is an iframe we talk to over postMessage — the game never shares
// a JS context with the editor, so a bad config can't take the editor down
// with it.

const $ = (id) => document.getElementById(id);

const el = {
  prompt: $('prompt'), make: $('make'), reroll: $('reroll'), starters: $('starters'),
  instruction: $('instruction'), applyEdit: $('applyEdit'), editChips: $('editChips'),
  log: $('log'), status: $('status'),
  title: $('gameTitle'), desc: $('gameDesc'), pill: $('templatePill'),
  preview: $('preview'), stageEmpty: $('stageEmpty'), stageBusy: $('stageBusy'), busyText: $('busyText'),
  restart: $('restart'), publish: $('publish'), notes: $('notes'), controlsHint: $('controlsHint'),
  published: $('published'), pageEditor: $('pageEditor'), republish: $('republish'),
  pgTitle: $('pgTitle'), pgTagline: $('pgTagline'), pgAccent: $('pgAccent'),
  pgBg: $('pgBg'), pgFont: $('pgFont'), pgLayout: $('pgLayout'),
  domain: $('domain'), dnsShow: $('dnsShow'), dnsVerify: $('dnsVerify'), dnsOut: $('dnsOut'),
};

const state = {
  game: null,
  lastPrompt: '',
  publishedId: null,
  page: null,
  frameTemplate: null,
  frameReady: false,
  busy: false,
  health: null,
};

const STARTERS = [
  'a cat ninja wall-jumping through a bamboo forest dodging guard dogs',
  'a raccoon robbing a night market while security guards patrol',
  'defend a greenhouse from waves of giant beetles',
  'smash a wall of candy bricks with a bouncing gumball',
  'a lost astronaut hopping between moon platforms collecting oxygen',
];

const EDIT_IDEAS = ['make it harder', 'now it\'s underwater', 'give them a double jump', 'more enemies', 'make it night time'];

// ── plumbing ────────────────────────────────────────────────────────────────

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ error: 'the server sent something that was not JSON' }));
  if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`);
  return data;
}

function log(who, text, kind = '', actions = []) {
  const div = document.createElement('div');
  div.className = `entry ${kind}`;
  div.innerHTML = `<div class="who">${who}</div><div class="what"></div>`;
  div.querySelector('.what').textContent = text;
  if (actions.length) {
    const bar = document.createElement('div');
    bar.className = 'act';
    for (const a of actions) {
      const b = document.createElement('button');
      b.className = 'btn small';
      b.textContent = a.label;
      b.onclick = () => { bar.remove(); a.run(); };
      bar.appendChild(b);
    }
    div.appendChild(bar);
  }
  el.log.prepend(div);
  while (el.log.children.length > 40) el.log.lastChild.remove();
}

function busy(on, text = 'building…') {
  state.busy = on;
  el.busyText.textContent = text;
  el.stageBusy.hidden = !on;
  el.make.disabled = on;
  el.make.textContent = on ? 'making…' : 'Make a rumpus';
  el.applyEdit.disabled = on || !state.game;
  el.reroll.disabled = on || !state.lastPrompt;
  el.publish.disabled = on || !state.game;
}

// ── preview ─────────────────────────────────────────────────────────────────

addEventListener('message', (e) => {
  const d = e.data;
  if (!d || typeof d !== 'object') return;
  if (d.type === 'rumpus:ready') {
    state.frameReady = true;
    pushConfig();
  }
  if (d.type === 'rumpus:error') {
    log('engine', `The game crashed: ${d.message}`, 'bad');
  }
});

function pushConfig() {
  if (!state.game || !state.frameReady) return;
  el.preview.contentWindow?.postMessage({ type: 'rumpus:config', config: state.game.config }, '*');
}

function mountPreview(game) {
  el.stageEmpty.hidden = true;
  el.preview.hidden = false;
  if (state.frameTemplate === game.template_id) {
    pushConfig();
    return;
  }
  // Different engine — reload the frame. Same engine, changed config — hot swap.
  state.frameTemplate = game.template_id;
  state.frameReady = false;
  el.preview.src = `/preview/${game.template_id}`;
}

// ── rendering the current game ──────────────────────────────────────────────

const CONTROLS = {
  'platformer-classic': 'arrows / WASD · space to jump',
  'top-down-collector': 'arrows / WASD to move',
  'top-down-shooter': 'WASD to move · mouse or X to shoot',
  'breakout-clone': 'mouse or arrows · space to launch',
};

function showGame(game) {
  state.game = game;
  el.title.textContent = game.title;
  el.desc.textContent = game.description;
  el.pill.hidden = false;
  el.pill.textContent = `${game.template_id} v${game.template_version}`;
  el.controlsHint.textContent = CONTROLS[game.template_id] ?? '';
  el.instruction.disabled = false;
  el.applyEdit.disabled = false;
  el.restart.disabled = false;
  el.publish.disabled = false;
  el.reroll.disabled = !state.lastPrompt;
  mountPreview(game);
  showNotes(game);
}

/**
 * Surface what the pipeline had to fix. A clamp or a carved corridor means the
 * generator produced something out of bounds — that should be visible, not
 * swallowed, or nobody ever learns the prompt needs work.
 */
function showNotes(game) {
  const n = game.notes ?? {};
  const notes = [];
  if (game.source === 'offline') {
    notes.push([n.degraded ? 'warn' : '', n.degraded
      ? `offline generator — ${n.degraded}`
      : 'offline generator (no API key) — keyword matched, level generated locally']);
  }
  if (n.clamps?.length) notes.push(['warn', `${n.clamps.length} value${n.clamps.length > 1 ? 's' : ''} clamped into safe range`]);
  if (n.errors?.length) notes.push(['bad', `${n.errors.length} schema error${n.errors.length > 1 ? 's' : ''} rejected`]);
  if (n.repaired) notes.push(['warn', 'level was unwinnable — carved a path to the goal']);
  if (game.changelog_note) notes.push(['ok', game.changelog_note]);
  if (n.why) notes.push(['', `picked because: ${n.why}`]);

  el.notes.innerHTML = '';
  el.notes.hidden = notes.length === 0;
  for (const [kind, text] of notes) {
    const d = document.createElement('div');
    d.className = `note ${kind}`;
    d.textContent = text;
    el.notes.appendChild(d);
  }
  if (n.clamps?.length) console.info('[rumpus] clamped:', n.clamps);
}

// ── actions ─────────────────────────────────────────────────────────────────

async function make(prompt) {
  const text = (prompt ?? el.prompt.value).trim();
  if (!text) {
    el.prompt.focus();
    return;
  }
  state.lastPrompt = text;
  log('you', text, 'you');
  busy(true, 'making a game…');
  try {
    const game = await api('/api/generate', { prompt: text });
    showGame(game);
    log('rumpus', `${game.title} — ${game.template_id}`, 'ok');
  } catch (err) {
    log('rumpus', `That one broke. ${err.message}`, 'bad');
  } finally {
    busy(false);
  }
}

async function applyEdit() {
  const instruction = el.instruction.value.trim();
  if (!instruction || !state.game) return;
  log('you', instruction, 'you');
  el.instruction.value = '';
  busy(true, 'changing it…');
  try {
    const result = await api('/api/edit', {
      templateId: state.game.template_id,
      config: state.game.config,
      instruction,
      title: state.game.title,
    });

    if (result.template_switch_required) {
      // Not a failure. Offer the switch, and be honest that it costs the
      // current game.
      log('rumpus', `${result.reason}${result.suggested_template ? ` That needs the ${result.suggested_template} template.` : ''}`, 'warn',
        result.suggested_template
          ? [{
              label: `Rebuild as ${result.suggested_template}`,
              run: () => rebuildAs(result.suggested_template, instruction),
            }]
          : []);
      return;
    }
    if (result.unavailable) {
      log('rumpus', result.message, 'warn');
      return;
    }
    showGame({ ...result, title: result.title || state.game.title });
    log('rumpus', result.changelog_note ?? 'Changed.', 'ok');
  } catch (err) {
    log('rumpus', `That edit broke. ${err.message}`, 'bad');
  } finally {
    busy(false);
  }
}

async function rebuildAs(templateId, extra) {
  busy(true, `rebuilding as ${templateId}…`);
  try {
    const game = await api('/api/generate', {
      prompt: `${state.lastPrompt}. ${extra}`,
      template: templateId,
    });
    showGame(game);
    log('rumpus', `Rebuilt on ${templateId}. The old config is gone.`, 'ok');
  } catch (err) {
    log('rumpus', `Rebuild failed. ${err.message}`, 'bad');
  } finally {
    busy(false);
  }
}

async function publish() {
  if (!state.game) return;
  busy(true, 'shipping…');
  try {
    const out = await api('/api/publish', {
      game: state.game,
      id: state.publishedId,
      page: state.page,
    });
    state.publishedId = out.id;
    state.page = out.page;
    renderPublished(out);
    fillPageEditor(out.page);
    log('rumpus', out.liveUrl
      ? `Live at ${out.liveUrl}`
      : `Bundled ${out.files} files. Serving locally at /p/${out.slug}/${out.deployError ? ` (Netlify: ${out.deployError})` : ''}`, 'ok');
  } catch (err) {
    log('rumpus', `Publish failed. ${err.message}`, 'bad');
  } finally {
    busy(false);
  }
}

function urlRow(kind, url, external = true) {
  return `<div class="url-row">
    <span class="k">${kind}</span>
    <a class="u" href="${url}" ${external ? 'target="_blank" rel="noopener"' : ''}>${url}</a>
  </div>`;
}

function renderPublished(out) {
  el.published.classList.remove('empty');
  const rows = [];
  if (out.liveUrl) rows.push(urlRow('live', out.liveUrl));
  if (out.subdomainUrl) rows.push(urlRow('subdomain', out.subdomainUrl));
  rows.push(urlRow('local', `${location.origin}/p/${out.slug}/`));
  if (!out.deployAvailable) {
    rows.push('<p class="muted tiny">Set NETLIFY_AUTH_TOKEN to push this to a real URL. The bundle is already built either way.</p>');
  } else if (out.deployError) {
    rows.push(`<p class="tiny" style="color:var(--bad)">Netlify: ${out.deployError}</p>`);
  }
  el.published.innerHTML = rows.join('');
  el.pageEditor.hidden = false;
}

function fillPageEditor(page) {
  el.pgTitle.value = page.hero.title;
  el.pgTagline.value = page.hero.tagline;
  el.pgAccent.value = page.theme.accent;
  el.pgBg.value = page.theme.background;
  el.pgFont.value = page.theme.font;
  el.pgLayout.value = page.layout;
}

function collectPage() {
  const page = structuredClone(state.page);
  page.hero.title = el.pgTitle.value;
  page.hero.tagline = el.pgTagline.value;
  page.theme.accent = el.pgAccent.value;
  page.theme.background = el.pgBg.value;
  page.theme.font = el.pgFont.value;
  page.layout = el.pgLayout.value;
  return page;
}

// ── custom domain ───────────────────────────────────────────────────────────

async function dnsShow() {
  const domain = el.domain.value.trim();
  if (!domain) return;
  try {
    const out = await api('/api/domain/instructions', { domain, id: state.publishedId });
    el.dnsOut.hidden = false;
    el.dnsOut.innerHTML = `
      ${out.records.map((r) => `<div class="rec"><b>${r.type}</b> &nbsp; ${r.name} &nbsp;→&nbsp; ${r.value}${r.note ? `<br><span class="muted">${r.note}</span>` : ''}</div>`).join('')}
      <p class="muted tiny">${out.hint}</p>`;
    el.dnsVerify.disabled = false;
  } catch (err) {
    el.dnsOut.hidden = false;
    el.dnsOut.innerHTML = `<p style="color:var(--bad)" class="tiny">${err.message}</p>`;
  }
}

async function dnsVerify() {
  const domain = el.domain.value.trim();
  if (!domain) return;
  el.dnsVerify.disabled = true;
  el.dnsVerify.textContent = 'checking…';
  try {
    const out = await api('/api/domain/verify', { domain, id: state.publishedId });
    const color = out.state === 'verified' ? 'var(--good)' : out.state === 'mismatch' ? 'var(--bad)' : 'var(--warn)';
    el.dnsOut.hidden = false;
    el.dnsOut.innerHTML =
      `<p class="tiny" style="color:${color}">${out.message}</p>` +
      (out.attached === true ? '<p class="tiny" style="color:var(--good)">Attached to the site.</p>' : '') +
      (typeof out.attached === 'string' ? `<p class="tiny" style="color:var(--bad)">Attach failed: ${out.attached}</p>` : '');
  } catch (err) {
    el.dnsOut.hidden = false;
    el.dnsOut.innerHTML = `<p style="color:var(--bad)" class="tiny">${err.message}</p>`;
  } finally {
    el.dnsVerify.disabled = false;
    el.dnsVerify.textContent = 'Check it';
  }
}

// ── wiring ──────────────────────────────────────────────────────────────────

el.make.onclick = () => make();
el.reroll.onclick = () => make(state.lastPrompt);
el.applyEdit.onclick = applyEdit;
el.publish.onclick = publish;
el.republish.onclick = () => { state.page = collectPage(); publish(); };
el.restart.onclick = () => {
  el.preview.contentWindow?.postMessage({ type: 'rumpus:restart' }, '*');
  el.preview.focus();
};
el.dnsShow.onclick = dnsShow;
el.dnsVerify.onclick = dnsVerify;

el.prompt.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) make();
});
el.instruction.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') applyEdit();
});
// Clicking the stage hands the keyboard to the game, not the editor.
$('stageBox').addEventListener('click', () => el.preview.focus());

for (const [target, list, run] of [
  [el.starters, STARTERS, (s) => { el.prompt.value = s; make(s); }],
  [el.editChips, EDIT_IDEAS, (s) => { el.instruction.value = s; applyEdit(); }],
]) {
  for (const s of list) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = s.length > 42 ? `${s.slice(0, 40)}…` : s;
    b.title = s;
    b.onclick = () => run(s);
    target.appendChild(b);
  }
}

(async function init() {
  try {
    const health = await api('/api/health');
    state.health = health;
    el.status.innerHTML =
      `<span class="dot ${health.ai ? 'on' : 'off'}"></span>${health.ai ? health.model : 'offline generator'}` +
      ` <span class="dot ${health.netlify ? 'on' : 'off'}"></span>${health.netlify ? 'netlify' : 'local publish'}` +
      ` <span class="muted">· ${health.templates} templates</span>`;
    if (!health.ai) {
      log('rumpus', 'No ANTHROPIC_API_KEY, so this is running the offline generator: keyword matching and locally generated levels. It works — it is just dumber, and conversational editing is off.', 'warn');
    }
  } catch {
    el.status.textContent = 'server unreachable';
  }
})();
