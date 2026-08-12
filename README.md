# Rumpus

**Describe a game. Play it. Ship it.**

Rumpus turns a plain-English game idea into a playable 2D game in seconds, lets
you change it by talking to it, and publishes it to a link you can share.

```
"a cat ninja who wall-jumps through a bamboo forest dodging guard dogs"
        ↓
   playable in the browser, immediately
        ↓
   catninja.rumpus.gg
```

## Run it

```bash
npm start          # http://localhost:4173
npm test           # 72 tests, no network needed
```

No install step. No build step. No dependencies — Node 20+ and nothing else.

It works with **no API key at all**: without one, Rumpus falls back to a local
generator (keyword classification, palette matching, procedural levels). That
path is obviously dumber than the model, and the UI says so rather than
pretending otherwise. Add a key to get the real thing:

```bash
ANTHROPIC_API_KEY=sk-...     # conversational editing + real generation
NETLIFY_AUTH_TOKEN=...       # publish to a real URL instead of serving locally
RUMPUS_ROOT_DOMAIN=rumpus.gg # wildcard subdomain per game
RUMPUS_MODEL=claude-sonnet-5 # default; the preview loop wants latency
ANTHROPIC_BASE_URL=...       # optional: gateway, proxy, or the test mock
```

## How it works

Rumpus does **not** write game engines. It ships hand-built, tested 2D
templates, each with a config schema and documented safe ranges. The model's
only job is to pick a template and write a config for it. Engine code never
changes, so generated games don't break.

Three layers, deliberately decoupled:

| Layer | What it is | Who edits it | Blast radius |
|---|---|---|---|
| **Engine** | Game loop, physics, collision, input | Humans, in this repo | Every game on that template — so it's versioned and pinned per published game |
| **Sprite parts** | Hand-drawn body plans and feature overlays | Humans, in this repo | Every game that composes them |
| **Game config** | JSON: theme, entities, level, rules, hooks | The model, from your prompt | One game's gameplay |
| **Arcade page** | The landing page wrapping the game | The model or a form | One game's presentation |

Restyling a page cannot break a game — the published `game.html` is
byte-identical across page restyles, and there's a test that asserts it.

### Art direction: composed sprites, one style token

Sprites aren't generated pixel-by-pixel and they aren't image files. They're
**composed from hand-drawn parts** — a body plan (`quadruped`, `biped`, `ship`,
`ghost`, `bug`, `bird`, …) plus feature overlays (`earsPointed`, `tail`,
`visor`, `antenna`, `crown`, `wings`, …), an eye style, and a marking pattern.
A cat is `quadruped + earsPointed + tail` with stripes. A robot is
`biped + visor + antenna`. The model picks parts; it never describes art.

And **one `style` token governs everything**: sprite outlines and shading,
terrain tiles, hazard shapes, particles, HUD chrome, the win/lose screen, and
the published landing page's fonts, borders and shadows.

| Style | Look |
|---|---|
| `pixel` | Hard 1px outlines, flat three-tone shading, mono HUD, hard offset shadows |
| `neon` | Dark ground, glowing edges, wide-tracked uppercase type |
| `storybook` | Thick soft outlines, warm paper, serif type, round cards |
| `clay` | No outlines, soft top-lighting, very round corners |

The page isn't styled to match the game by hand — its palette is computed from
the game's colours and its CSS from the game's style token, so the two can't
drift. Switching style in the editor restyles the game and its page together.

Browse every part in every style at `/styles.html`.

### Four checks stand between the model and a broken game

1. **Schema validation.** Unknown keys are rejected, not merged. Wrong types are
   errors. The model gets exactly one repair retry with its own errors quoted back.
2. **Range clamping.** Out-of-range numbers are clamped and logged, never
   rejected — the value that plays beats the error nobody reads. This runs in the
   renderer too, so the prompt is never the only guard.
3. **Winnability.** Each template declares how its levels get checked, because
   "winnable" means something different per archetype: a flood fill for top-down
   games, a jump-aware search for platformers (reach derived from the config's
   own gravity and jump power), and a **bounded solver** for the push puzzle,
   which can be fully connected and still impossible. Unwinnable levels get
   reseeded, then carved open — or, for a push puzzle, replaced with one that is
   solvable by construction. A level the solver can't settle inside its budget
   is reported as unverified, never as broken.
4. **Headless simulation.** Every example config runs 20 seconds of real game
   time in the test suite, plus every schema minimum and maximum.

## The template library

| Template | Verb | Hooks |
|---|---|---|
| `platformer-classic` | jump, run, collect | doubleJump, dash, wallJump, stomp, shoot, gravityFlip |
| `top-down-collector` | collect, sneak, explore | dash, sprint, lantern, magnet |
| `top-down-shooter` | shoot, survive | spread, pierce, dashRoll, shield, homing |
| `breakout-clone` | bounce, break | multiball, sticky, lasers, widen |
| `endless-runner` | run, jump, duck | doubleJump, duck, dash, magnet, shield |
| `puzzle-sokoban` | push, plan | undo, deadlockWarning, sprint |

Two of them can't be built wrong at all: the runner has no authored level, and
generated push puzzles are built by reverse-pulling crates from the solved
position, so solvability is structural rather than searched for.

Each ships an engine, a schema with safe ranges, a hook list, and 2+ example
configs used as regression tests. Adding a template means adding all five —
there's a test that fails if a schema and its engine disagree about hooks, and
another that fails if the classifier prompt and the installed set drift apart.

## Layout

```
shared/       validation, clamping, reachability, sprites, styles, game runtime
templates/    one directory per archetype: engine.js + schema.json + examples/
arcade/       the landing-page template and its own config schema
server/       zero-dep HTTP server, generation pipeline, bundler, deploy, DNS
web/          the editor, plus /styles.html — the sprite and style gallery
test/         72 tests, including a mock Claude endpoint and a function harness
```

## Deploying

Rumpus runs as a Node server locally and as static files + one Netlify Function
in production. Both call the same `server/api.js`, so they can't drift.

The simplest route is to connect this repo in Netlify's UI — Netlify clones and
builds it, so nothing needs to be installed locally. Or from a machine with
network access to Netlify:

```bash
npm run build            # assembles build/ — the static publish directory
netlify deploy --prod
```

`netlify.toml` has it wired: `build/` is published, `netlify/functions/api.mjs`
claims `/api/*` and `/p/*`.

Set these in **Site configuration → Environment variables**:

| Variable | Effect if unset |
|---|---|
| `ANTHROPIC_API_KEY` | Site still works, on the offline generator. No AI generation or conversational editing. |
| `NETLIFY_AUTH_TOKEN` | Published games are served from the app at `/p/<slug>/` instead of getting their own Netlify site. |
| `RUMPUS_ROOT_DOMAIN` | No per-game subdomains. |

Two things about the hosted version worth knowing:

- **Published games live in Netlify Blobs**, not on disk. A function's
  filesystem is scratch space that vanishes with the container, so anything
  written there would survive until the next cold start.
- **The store is a single JSON document.** Fine at this size; it would want
  splitting per-game before it saw real concurrent traffic, since two
  simultaneous publishes can race on it.

## Docs

- [`docs/naming.md`](docs/naming.md) — why it's called Rumpus
- [`docs/system-prompt.md`](docs/system-prompt.md) — the prompt driving generation
- [`docs/architecture.md`](docs/architecture.md) — pipeline, deploy, DNS, arcade page
- [`docs/build-order.md`](docs/build-order.md) — what's built and what's next

## Status

Steps 1–5 of the build order are implemented and tested end to end: prompt →
config → live preview → conversational edit → publish → arcade page → custom
domain. Step 6 is template-library expansion, which is ongoing by design.

Two things are **unverified against live services** because this environment has
no credentials: real Claude API calls and real Netlify deploys. Both paths are
covered up to the network boundary — the generation pipeline is tested against a
mock Claude endpoint, and the Netlify client is written against the documented
file-digest API but has never been run against netlify.com.
