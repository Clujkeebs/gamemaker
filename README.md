# Rumpus

**Describe a game. Play it. Ship it.**

Rumpus turns a plain-English game idea into a playable 2D HTML5 game in seconds,
lets you edit it by talking to it, and publishes it to a live URL you can share.

```
"a cat ninja who wall-jumps through a bamboo forest dodging guard dogs"
        ↓
   playable in the browser, immediately
        ↓
   catninja.rumpus.gg
```

## How it works

Rumpus does **not** write game engines. It ships a library of hand-built, tested
2D game templates — a platformer, a top-down shooter, a match-3, a sokoban, and a
dozen more — each with a documented config schema. The AI's only job is to pick
the right template and write a config for it. The engine code never changes, so
generated games don't break.

Three layers, deliberately decoupled:

| Layer | What it is | Who edits it |
|---|---|---|
| **Engine** | Tested template code, one file per archetype | Humans only. Never the AI. |
| **Game config** | JSON: theme, entities, level, rules, hooks | AI, from your prompt |
| **Arcade page** | The landing page wrapping the published game | AI or a form UI, separately |

Restyling the site can't break the game. Retuning the game can't break the site.

## Docs

- [`docs/naming.md`](docs/naming.md) — why it's called Rumpus
- [`docs/system-prompt.md`](docs/system-prompt.md) — the system prompt driving the generation engine
- [`docs/architecture.md`](docs/architecture.md) — generation, deploy, DNS, and site customization
- [`docs/build-order.md`](docs/build-order.md) — what to build first, and where it's safe to stop

## Status

Spec stage. Nothing here is built yet — see the build order for the intended
sequence and the cut points that still leave a complete demo.
