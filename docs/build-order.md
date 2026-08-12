# Rumpus — build order

Ordered so that every stopping point after step 3 is a complete demo, not a
half-finished one.

**Status: steps 1-5 are built and tested; step 6 is ongoing by design.**
Each step below carries what actually shipped.

### 1. Prompt → config → live in-app preview

> **Built.** Two-call pipeline (classify, then configure with only that
> template's schema in context), sandboxed iframe preview over postMessage,
> renderer-side clamping, and a reachability pass before first render. Plus an
> offline generator so the loop works with no API key.

The core loop. Must be rock solid — everything else is a layer on top of it, and
nothing else matters if this stutters.

Needs: two templates minimum (`platformer-classic`, `top-down-collector`), their
schemas and safe ranges, the classify + config prompt chain, the iframe renderer
with numeric clamping.

**Cut point value:** demoable but not shippable. Don't stop here.

### 2. Conversational editing within a template

> **Built.** Full-config round-trips (never diffs), `changelog_note` surfaced
> in the log, and `template_switch_required` wired to a one-click rebuild offer
> that says plainly it discards the current config. Needs an API key.

"Make it harder." "Now it's underwater." "Give him a double jump."

Needs: config round-tripping, full-config-not-diff returns, `changelog_note` in
the UI, and the `template_switch_required` path wired to a real offer rather
than an error toast.

**Cut point value:** this is the moment the product stops looking like a toy.
The gap between *generated a game* and *shaped a game by talking to it* is the
entire pitch.

### 3. One-click deploy to a subdomain

> **Built.** Bundler, slug allocation with reserved names and collision
> suffixes, stable-URL republish, and a Netlify file-digest deploy client.
> Without a token the bundle is still built and served locally, so publish is
> demoable with no hosting account. The Netlify client is untested against the
> live API.

Netlify bundle + wildcard DNS on `rumpus.gg`. No custom domains yet.

Needs: bundler, deploy connector call, slug allocation with collision handling,
stable-URL republish.

**Cut point value:** ✅ **first genuinely complete demo.** Type an idea, play it,
talk to it, share a real link that works on a stranger's phone. If time runs out
here, the story is whole.

### 4. Arcade page generation + light customization

> **Built.** Its own template and config schema, copy derived from the game
> (including hook-aware how-to-play steps), and a form UI for title, tagline,
> colors, font, and layout.

The landing wrapper and its config schema.

Needs: page template, page config schema, AI restyle path plus a form UI for the
same knobs.

**Cut point value:** published games stop looking like raw output and start
looking like something someone made.

### 5. Bring your own domain

> **Built.** Record instructions for apex and subdomain cases, verification
> against public resolvers rather than the system one, honest pending/mismatch
> states, and automatic attachment once the record resolves.

DNS instruction display, resolution polling with honest status, domain
attachment and certificate provisioning via the host API.

**Cut point value:** the credible "we do DNS" answer. Skip Tier 3 (purchasing)
entirely — see `architecture.md` §5.

### 6. Template library expansion

> **In progress.** Six of the fifteen archetypes are built:
> `platformer-classic`, `top-down-collector`, `top-down-shooter`,
> `breakout-clone`, `endless-runner`, `puzzle-sokoban` — covering jump,
> collect, shoot, bounce, run, and push.
>
> The push puzzle was the one that needed new infrastructure rather than just a
> new engine: "winnable" there is a search, not a walk, so it brought a bounded
> solver, deadlock detection, and reverse-pull level generation with it. Worth
> knowing before picking the next archetype — `match-3` and `physics-puzzle`
> will each want their own notion of a valid level too.

Remaining, in rough order of how often people ask for them: `match-3`,
`physics-puzzle`, `maze-stealth`, `racing-topdown`, `tower-defense-lite`,
`rhythm-timing`, `idle-clicker`, `card-battler-lite`.

Each new template is a fixed cost: engine + schema + safe ranges + 2-3 example
configs + hook list. Don't add one without all five, and don't let the AI's
template list drift from the registry.

---

## The rule this ordering encodes

Front-load the thing judges and users see first — prompt to playable, live, in
the browser. Treat deploy, DNS, and site customization as sequential layers on
a working core rather than parallel workstreams. At every step past 3 there's a
coherent product to show, and nothing is left in a state where it half-works.
