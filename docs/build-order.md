# Rumpus — build order

Ordered so that every stopping point after step 3 is a complete demo, not a
half-finished one.

### 1. Prompt → config → live in-app preview

The core loop. Must be rock solid — everything else is a layer on top of it, and
nothing else matters if this stutters.

Needs: two templates minimum (`platformer-classic`, `top-down-collector`), their
schemas and safe ranges, the classify + config prompt chain, the iframe renderer
with numeric clamping.

**Cut point value:** demoable but not shippable. Don't stop here.

### 2. Conversational editing within a template

"Make it harder." "Now it's underwater." "Give him a double jump."

Needs: config round-tripping, full-config-not-diff returns, `changelog_note` in
the UI, and the `template_switch_required` path wired to a real offer rather
than an error toast.

**Cut point value:** this is the moment the product stops looking like a toy.
The gap between *generated a game* and *shaped a game by talking to it* is the
entire pitch.

### 3. One-click deploy to a subdomain

Netlify bundle + wildcard DNS on `rumpus.gg`. No custom domains yet.

Needs: bundler, deploy connector call, slug allocation with collision handling,
stable-URL republish.

**Cut point value:** ✅ **first genuinely complete demo.** Type an idea, play it,
talk to it, share a real link that works on a stranger's phone. If time runs out
here, the story is whole.

### 4. Arcade page generation + light customization

The landing wrapper and its config schema.

Needs: page template, page config schema, AI restyle path plus a form UI for the
same knobs.

**Cut point value:** published games stop looking like raw output and start
looking like something someone made.

### 5. Bring your own domain

DNS instruction display, resolution polling with honest status, domain
attachment and certificate provisioning via the host API.

**Cut point value:** the credible "we do DNS" answer. Skip Tier 3 (purchasing)
entirely — see `architecture.md` §5.

### 6. Template library expansion

Add archetypes as time allows, in rough order of how often people ask for them:
`top-down-shooter`, `breakout-clone`, `endless-runner`, `puzzle-sokoban`,
`match-3`, then the rest.

Each new template is a fixed cost: engine + schema + safe ranges + 2-3 example
configs + hook list. Don't add one without all five, and don't let the AI's
template list drift from the registry.

---

## The rule this ordering encodes

Front-load the thing judges and users see first — prompt to playable, live, in
the browser. Treat deploy, DNS, and site customization as sequential layers on
a working core rather than parallel workstreams. At every step past 3 there's a
coherent product to show, and nothing is left in a state where it half-works.
