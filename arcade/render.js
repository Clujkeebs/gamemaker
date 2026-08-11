// Renders an arcade page config into standalone HTML.
//
// The page embeds the game in an iframe pointing at game.html rather than
// inlining it. That makes the decoupling physical: you can regenerate this
// entire file and the game bytes never change.

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

/**
 * JSON destined for inside a <script> block.
 * JSON.stringify alone is not enough: a title containing "</script>" would end
 * the block early and the rest would parse as markup. Escaping `<` closes that
 * off without changing the parsed value.
 */
const jsonInScript = (value) =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

const FONTS = {
  system: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  rounded: 'ui-rounded, "SF Pro Rounded", "Segoe UI Variable", system-ui, sans-serif',
  mono: 'ui-monospace, Menlo, Consolas, monospace',
  serif: 'Iowan Old Style, Georgia, "Times New Roman", serif',
};

/** Sensible page copy derived from the game, so a publish never needs a form. */
export function defaultPage(game, schemaDefaults) {
  const page = structuredClone(schemaDefaults);
  page.hero.title = game.title;
  page.hero.tagline = game.description;
  page.hero.ctaLabel = 'Play';
  page.about.body = game.description;
  page.howTo.steps = controlsFor(game);
  page.credits.body = 'Made in Rumpus from a one-line idea.';
  return page;
}

function controlsFor(game) {
  const hooks = new Set(game.config?.mechanicHooks ?? []);
  const steps = [];
  switch (game.template_id) {
    case 'platformer-classic':
      steps.push('Arrows or A/D to run', 'Space to jump');
      if (hooks.has('doubleJump')) steps.push('Space again in mid-air to double jump');
      if (hooks.has('dash')) steps.push('Shift to dash');
      if (hooks.has('shoot')) steps.push('X to shoot');
      if (hooks.has('gravityFlip')) steps.push('Down to flip gravity');
      steps.push(game.config?.rules?.win === 'collectAll'
        ? 'Collect every last one to win'
        : 'Reach the flag to win');
      break;
    case 'top-down-collector':
      steps.push('Arrows or WASD to move');
      if (hooks.has('dash')) steps.push('Shift to dash');
      if (hooks.has('sprint')) steps.push('Hold shift to sprint');
      steps.push(game.config?.rules?.win === 'reachGoal'
        ? 'Find the exit and get out'
        : 'Grab everything without getting caught');
      break;
    case 'top-down-shooter':
      steps.push('WASD to move',
        game.config?.combat?.aim === 'mouse' ? 'Mouse to aim, click to shoot' : 'X to shoot the way you are facing');
      if (hooks.has('dashRoll')) steps.push('Shift to roll');
      if (hooks.has('shield')) steps.push('Shift to raise your shield');
      steps.push(game.config?.rules?.win === 'survive' ? 'Survive the clock' : 'Clear every wave');
      break;
    case 'breakout-clone':
      steps.push('Move the mouse or use arrows', 'Space or click to launch', 'Clear the whole wall');
      break;
    default:
      steps.push('Arrows or WASD to move');
  }
  return steps.slice(0, 6);
}

export function renderArcadePage(page, game, opts = {}) {
  const t = page.theme;
  const font = FONTS[t.font] ?? FONTS.rounded;
  const sections = (page.sections ?? []).map((name) => {
    if (name === 'howTo' && page.howTo.steps?.length) {
      return `<section class="card"><h2>${esc(page.howTo.heading)}</h2><ul class="steps">${
        page.howTo.steps.filter(Boolean).map((s) => `<li>${esc(s)}</li>`).join('')
      }</ul></section>`;
    }
    if (name === 'about' && page.about.body) {
      return `<section class="card"><h2>${esc(page.about.heading)}</h2><p>${esc(page.about.body)}</p></section>`;
    }
    if (name === 'credits' && page.credits.body) {
      return `<section class="card"><h2>${esc(page.credits.heading)}</h2><p>${esc(page.credits.body)}</p></section>`;
    }
    return '';
  }).join('\n      ');

  const badge = page.footer.badge
    ? `<a class="badge" href="https://rumpus.gg" target="_blank" rel="noopener">Made with <b>Rumpus</b></a>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(page.hero.title)}</title>
<meta name="description" content="${esc(page.hero.tagline)}">
<meta property="og:title" content="${esc(page.hero.title)}">
<meta property="og:description" content="${esc(page.hero.tagline)}">
<meta property="og:type" content="website">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><text y='26' font-size='26'>%F0%9F%95%B9%EF%B8%8F</text></svg>">
<style>
  :root{
    --bg:${t.background}; --surface:${t.surface}; --text:${t.text};
    --muted:${t.muted}; --accent:${t.accent}; --font:${font};
  }
  *{box-sizing:border-box}
  html,body{margin:0}
  body{
    background:var(--bg); color:var(--text); font-family:var(--font);
    line-height:1.55; -webkit-font-smoothing:antialiased;
    padding:clamp(16px,4vw,48px) 16px 48px;
  }
  .wrap{max-width:${page.layout === 'split' ? '1120' : '760'}px; margin:0 auto}
  header{text-align:${page.layout === 'split' ? 'left' : 'center'}; margin-bottom:24px}
  h1{
    font-size:clamp(30px,6vw,52px); line-height:1.05; margin:0 0 10px;
    letter-spacing:-0.02em;
  }
  .tagline{color:var(--muted); font-size:clamp(15px,2.2vw,19px); margin:0 auto; max-width:52ch}
  ${page.layout === 'split' ? '.main{display:grid; grid-template-columns:minmax(0,1.6fr) minmax(260px,1fr); gap:28px; align-items:start}' : '.main{display:block}'}
  @media (max-width:860px){ .main{display:block} }
  .stage{
    position:relative; background:#000; border-radius:14px; overflow:hidden;
    aspect-ratio:16/9; box-shadow:0 18px 50px rgba(0,0,0,.45);
    border:1px solid rgba(255,255,255,.08);
  }
  .stage iframe{width:100%; height:100%; border:0; display:block}
  .cover{
    position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
    background:linear-gradient(160deg, var(--surface), var(--bg));
    cursor:pointer; border:0; width:100%; font:inherit; color:inherit;
  }
  .play{
    display:inline-flex; align-items:center; gap:10px;
    background:var(--accent); color:#10121a; font-weight:800;
    font-size:clamp(16px,2.4vw,20px); padding:14px 30px; border-radius:999px;
    box-shadow:0 8px 24px rgba(0,0,0,.35);
  }
  .play:hover{transform:translateY(-1px)}
  .cards{margin-top:22px; display:grid; gap:14px}
  ${page.layout === 'split' ? '.side .cards{margin-top:0}' : ''}
  .card{background:var(--surface); border-radius:12px; padding:18px 20px; border:1px solid rgba(255,255,255,.06)}
  .card h2{margin:0 0 8px; font-size:15px; text-transform:uppercase; letter-spacing:.09em; color:var(--accent)}
  .card p{margin:0; color:var(--muted)}
  .steps{margin:0; padding-left:18px; color:var(--muted)}
  .steps li{margin:3px 0}
  footer{margin-top:32px; text-align:center; color:var(--muted); font-size:13px}
  .badge{color:var(--muted); text-decoration:none; border-bottom:1px solid rgba(255,255,255,.15)}
  .badge b{color:var(--text)}
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1>${esc(page.hero.title)}</h1>
      <p class="tagline">${esc(page.hero.tagline)}</p>
    </header>

    <div class="main">
      <div class="stage" id="stage">
        <button class="cover" id="cover" aria-label="${esc(page.hero.ctaLabel)}">
          <span class="play">▶ ${esc(page.hero.ctaLabel)}</span>
        </button>
      </div>
      <div class="side">
        <div class="cards">
      ${sections}
        </div>
      </div>
    </div>

    <footer>
      ${page.footer.text ? `<p>${esc(page.footer.text)}</p>` : ''}
      ${badge}
    </footer>
  </div>
<script>
  // The game only loads when asked for. A landing page that starts capturing
  // arrow keys before you click is a landing page people bounce off.
  var cover = document.getElementById('cover');
  cover.addEventListener('click', function () {
    var f = document.createElement('iframe');
    f.src = ${jsonInScript(opts.gameSrc ?? './game.html')};
    f.title = ${jsonInScript(page.hero.title)};
    f.allow = 'autoplay';
    document.getElementById('stage').appendChild(f);
    cover.remove();
    f.focus();
  });
</script>
</body>
</html>`;
}

/** The standalone game page: pinned engine + inlined config, nothing else. */
export function renderGamePage(game, opts = {}) {
  const enginePath = opts.enginePath ?? `./templates/${game.template_id}/engine.js`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(game.title)}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><text y='26' font-size='26'>%F0%9F%95%B9%EF%B8%8F</text></svg>">
<style>
  html,body{margin:0;height:100%;background:#000;overflow:hidden}
  body{display:flex;align-items:center;justify-content:center}
  canvas{
    width:100%; height:100%; object-fit:contain; display:block;
    image-rendering:pixelated; touch-action:none;
  }
</style>
</head>
<body>
<canvas id="stage"></canvas>
<script>
  // Pinned at publish time: template ${game.template_id} v${game.template_version}.
  // Improving that engine later must never change this already-shared game.
  window.RUMPUS_CONFIG = ${jsonInScript(game.config)};
  window.RUMPUS_META = ${jsonInScript({
    title: game.title,
    template_id: game.template_id,
    template_version: game.template_version,
  })};
</script>
<script type="module" src="${enginePath}"></script>
</body>
</html>`;
}
