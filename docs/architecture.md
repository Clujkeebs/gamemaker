# Rumpus — architecture

Generation, deploy, DNS, and site customization.

## 1. The pipeline

```
User prompt
   → AI classifies + writes config          (docs/system-prompt.md)
   → Renderer combines template engine + config → live iframe preview
   → User iterates conversationally          (loops back with current config)
   → User clicks "Let it loose"
   → Deploy pipeline → live URL              (subdomain, or custom domain)
   → User customizes the arcade page around the game
```

The load-bearing idea: **the AI never emits engine code.** It emits a config for
a template a human wrote and tested. Everything downstream — preview, deploy,
restyle — operates on that config, so no step in the pipeline can produce a game
that doesn't run.

## 2. The three artifacts

A game in Rumpus is three separable things. Keeping them separate is what makes
the whole thing safe to edit.

| Artifact | Contents | Mutated by | Blast radius |
|---|---|---|---|
| **Template engine** | Game loop, physics, collision, input | Humans, in the repo | All games on that template — so it's versioned and regression-tested |
| **Game config** | JSON: theme, entities, level, rules, hooks | AI, per prompt | One game's gameplay |
| **Arcade page config** | JSON: colors, fonts, section order, copy | AI or a form UI | One game's presentation |

Restyling the arcade page cannot break the game. Retuning the game cannot break
the page. That decoupling is worth defending even when a shortcut is tempting.

### Template versioning

Templates are pinned per game: a published game records `template_id` **and**
`template_version`, and the deployed bundle inlines that exact engine file.
Improving `platformer-classic` must never silently change a game someone already
shared. Migration to a newer engine version is an explicit, opt-in action with a
preview.

## 3. Rendering and preview

The preview is the product. It runs client-side, in an iframe:

- The iframe loads the template engine (static, cached) and receives the config
  via `postMessage`.
- Config changes hot-swap without a page reload where the template supports it,
  and hard-reload the iframe where it doesn't. Either way, no server round trip
  beyond the AI call.
- The renderer **clamps every numeric to the template's documented safe range**
  before handing it to the engine, and logs any clamp. A clamp firing is a
  prompt bug worth seeing — surface it in dev, swallow it in production.
- The iframe is sandboxed (`allow-scripts` only, no same-origin). Generated
  content is untrusted by construction, even though today it's config-only.

## 4. Deployment

**Target:** Netlify. Each published game is a static bundle — no server, no
build step, no runtime dependency.

The bundle:

```
index.html                      arcade page (landing wrapper), config inlined
game.html                       the game: pinned engine + inlined config
templates/<id>/engine.js        copy of the engine, taken at publish time
shared/*.js                     only the modules that engine actually imports
_headers                        immutable for engine code, no-cache for HTML
rumpus.json                     what was published, and from which template version
```

The layout mirrors the repo so the engine's own relative imports keep working
with no bundler and no transpile step. The `shared/` copy is the engine's real
import graph, walked at publish time — a published game has no business
shipping the validator or the level checker, which run here, before anything is
written.

The game runs in an iframe inside `index.html`, from `game.html`. That's the
same decoupling as above, made physical: the arcade page can be redeployed with
completely different markup and the game file is byte-identical.

**Publish flow:**

1. Bundle: engine (pinned version) + game config + arcade page config → folder.
2. Deploy connector creates or updates the Netlify site for this game.
3. Return the live URL **immediately**. This is the zero-config path — every
   user gets a shareable link with no setup, no account linking, no DNS.

Re-publishing updates the same site in place. Keep the URL stable across edits;
the link a user already shared must not rot because they retuned jump height.

## 5. DNS and domains

Three tiers, in the order they're worth building.

### Tier 1 — free subdomain (default, build this)

Every published game gets `<slug>.rumpus.gg` under a root domain we own.

Requirements, all modest:
- One owned root domain (`rumpus.gg`).
- Wildcard DNS (`*.rumpus.gg`) pointed at the host, plus a wildcard certificate
  so new subdomains are live and HTTPS-valid the instant they exist — no
  per-subdomain DNS API call in the request path.
- Slug allocation: derive from the title, lowercase, dash-separated, collision
  suffix on conflict (`cat-ninja-2`). Reserve the obvious names (`www`, `api`,
  `admin`, `mail`, and anything that could be mistaken for us) up front.

Wildcard DNS is what makes this a five-minute feature instead of a registrar
integration. Do not build per-subdomain record creation unless something forces
it.

### Tier 2 — bring your own domain (build if time allows)

User already owns `mygame.com` and wants it pointed here.

1. User enters their domain in-app.
2. App shows the exact records to add at their registrar (CNAME for a subdomain,
   A/ALIAS for an apex), with copy buttons and a screenshot-grade example.
3. App polls DNS until the record resolves. Show real state — "not visible yet,
   propagation can take up to an hour" beats a spinner, and beats a false
   failure at minute three.
4. On resolve, attach the domain to the deployed site via the host's domain API
   and provision the certificate.

This is a *show instructions and verify* flow, not automation. We don't control
their registrar and shouldn't pretend to.

### Tier 3 — domain purchasing (out of scope)

Registrar integration, payment, WHOIS, ICANN verification, renewals, and the
support burden of owning someone's domain. Real work, none of it demoable, all
of it a liability. Explicitly not in scope. Tier 2 is the honest, complete
version of "DNS."

## 6. The arcade page

A published game isn't a bare canvas on a white background — it ships with a
landing page, and that page is its own editable layer.

**Structure:**
- Hero: title, tagline, big **Play** button that launches the embedded game.
- Optional sections, in any order: how to play, screenshots/GIF, credits,
  footer/branding.

**Customization:** the arcade page is a template with a config schema, exactly
like the game — colors, fonts, section order, copy. Same pattern, same
guarantees, so the AI can restyle a site with the same machinery that restyles a
game, and a plain form UI can drive it too when the user would rather click than
type.

**Why it's separate, restated:** presentation and gameplay fail independently.
A user fiddling with their page's font can't produce a game that won't load, and
that property is worth more than any convenience gained by merging them.

## 7. Art direction

Generated games need to look deliberate, and "deliberate" mostly means
*consistent*. Two mechanisms carry that.

### Sprites are composed, not described

There is no image generation and no asset pipeline. Characters are built from a
library of hand-drawn 16x16 body plans (`biped`, `quadruped`, `ghost`, `ship`,
`bug`, `bird`, `fish`, `car`, …) with hand-drawn feature overlays layered on
(`earsPointed`, `tail`, `visor`, `antenna`, `horns`, `crown`, `wings`, …), plus
an eye style and a marking pattern. A cat is `quadruped + earsPointed + tail`
with stripes; a robot is `biped + visor + antenna`.

The generator's only job is to pick parts — the same "configure, don't invent"
rule the whole product runs on. That matters because the obvious alternative,
random symmetric noise, reliably produces mush. A silhouette someone drew reads
as a creature; a silhouette a PRNG drew reads as a mistake.

Details that carry most of the quality, and are easy to get wrong:

- **Front-facing plans are authored as an 8-wide half and mirrored**, so
  symmetry is exact rather than approximate. Side-facing plans are authored full
  width and flipped to face travel — and they need their **own** overlay
  variants, because a front-facing ear mask lands on a side-view creature's back.
- **Patterns only paint over plain body pixels**, so a stripe can never cover a
  face, and stripes run across the spine (vertical on a side view, horizontal
  head-on) — backwards, and a tiger reads as a creature wearing a belt.
- **Rasterizing is cached** per (parts + palette + style + size); drawing is one
  `drawImage` per entity per frame.

`web/styles.html` renders every part in every style. It is the page to look at
before and after changing a mask.

### One style token governs everything

`style` is a single enum — `pixel`, `neon`, `storybook`, `clay` — and it drives
every visual layer: sprite outlines and shading, terrain tiles, hazard shapes,
particles, HUD chrome, the win/lose overlay, and **the published landing page's
fonts, borders, and shadows**.

The page is not styled to match the game by hand. Its palette is computed from
the game's own colours and its CSS from the game's own style token, so the two
cannot drift. A stale style stored on a page loses to the game's current one.

Colour stays separate from style on purpose: the palette comes from the theme,
the style says how that palette is rendered. That split is what lets "a haunted
library" and "a candy factory" share a style and still look like themselves.

One rendering subtlety worth stating, because it's the difference between
terrain and confetti: **tiles are drawn with their neighbours**. Only exposed
corners get rounded and only exposed edges get an outline. Round every corner
and a run of ground becomes a row of separate balls.

## 8. Running without credentials

Neither an API key nor a hosting token is required to run the whole loop.

- **No `ANTHROPIC_API_KEY`** — an offline generator takes over: keyword
  classification against the same template catalog, a palette chosen from the
  words in the prompt, and procedurally generated levels (randomized-DFS mazes,
  which are connected by construction). It is meaningfully dumber than the
  model and the UI says so plainly rather than quietly degrading. Conversational
  editing is off, since there is nothing to converse with.
- **No `NETLIFY_AUTH_TOKEN`** — the bundle is still built and served from the
  app at `/p/<slug>/`, so publishing is demoable end to end with no account.

This is a deliberate cost: a demo that dies on a missing environment variable is
a demo that dies.

## 9. Failure modes worth designing for now

These are the ones that will actually bite, listed so they're a decision rather
than a surprise.

- **Out-of-range numerics.** The prompt asks for safe values; the renderer
  clamps regardless. Two independent checks, because this is the top cause of
  unplayable output.
- **Unwinnable levels.** Procedural layouts can wall off the goal. Every level
  template needs a reachability check (flood fill from spawn to goal) before the
  preview renders, with a bounded number of reseeds and a known-good fallback
  layout.
- **Invented config keys.** Validate against the JSON Schema and reject, don't
  merge. An unknown key is a model error to retry, not a value to pass through.
- **Slow AI calls.** The preview is the demo. Stream what can be streamed, show
  the previous game while the next config lands, and never blank the canvas
  while waiting.
- **A shared link that breaks.** Republishing must preserve the URL, and the
  pinned engine version must never be upgraded underneath a live game.
