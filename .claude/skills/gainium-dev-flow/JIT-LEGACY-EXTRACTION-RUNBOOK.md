# Just-in-time legacy extraction runbook

Referenced from [SKILL.md](SKILL.md) Part 4. Read this before pulling
apart any existing code as part of a bug fix or small feature. This is
a *how*, not a policy restatement — the policy (which spec template,
when this applies) lives in the skill.

**This file is the same in every gainium repo and names no specific
file from any of them.** Step 0 below is how you find *this repo's*
own real examples before writing anything — don't reach for a file you
remember from a different repo; it may not exist here, and even if a
similarly-named one does, this repo's conventions may differ.

## The smell this fixes

A function or method mixes a business decision (a calculation, a
sizing/rule, a retry/backoff policy, an invariant check) with I/O (a DB
query, a cache call, an HTTP/exchange call, a queue publish, a socket
emit) in the same block. Symptom: you cannot exercise the business rule
without first standing up or mocking the I/O it happens to be next to —
which is usually exactly why that logic has no test today.

The goal is **boiling-frog modernization**: every bug fix or small
feature that has to read through one of these blocks anyway leaves that
specific patch of code better organized than it found it. Never a
drive-by rewrite of the whole file.

## Step 0 — find this repo's own examples first

Before extracting anything, search *this* repo for files that already
look like a Tier 1 or Tier 2 extraction (below): small, narrowly-named
modules near the code you're editing — names like `*Helper`, `*Rules`,
`*Guard`, `*Policy`, `*Backoff`, or similar; anything with a colocated
test/spec file and a short, single-purpose export list. Open one and
mirror its shape — naming convention, file placement, how much I/O it
still carries — rather than inventing a new one.

If nothing like that exists yet in this repo, your extraction sets the
precedent. Keep it as small and boring as the ladder below describes —
the next person here (human or agent) will copy your shape.

## Decision ladder — pick the lowest tier that removes the smell on your causal path

**Tier 0 — leave it alone.** The logic isn't on the path you're
changing and you didn't need to read it closely to make your change
safely. Don't touch it. Most of the file, most of the time.

**Tier 1 — extract, even if it stays infra-coupled.** Pull the block
into its own named, single-purpose module colocated next to the
original file (`fooBar.ts` → `fooBarRetry.ts`, not a new `domain/`
folder — introducing a directory shape this repo doesn't already have,
for one file, creates an orphaned convention). It's fine if the
extracted module still imports the DB/cache/exchange client it needs —
the win here is *naming the seam and making it independently
callable/testable*, not purity. A module extracted-but-still-coupled is
a legitimate, real destination, not a stepping stone you must push past.

**Tier 2 — go fully pure, where the logic naturally allows it.** If the
block you're extracting doesn't actually need the I/O — it takes values
in and returns a decision/number/shape out — make it a plain
function/type module with zero infra imports. Prefer this over Tier 1
whenever it falls out naturally; don't force it by threading five extra
parameters through a function to avoid one client call it genuinely
needs — that's Tier 1 pretending to be Tier 2, and the contortion is
worse than the coupling it avoids.

**Tier 3 — full ports-and-adapters.** Define a port interface and swap
the extracted logic behind it, per SKILL.md Part 3. This is real
architectural surgery — reserve it for a deliberate modernization task
called out as such (its own small spec/plan, even if lightweight), or
for code that's genuinely new. Do not let a bug fix's plan casually
escalate into this tier; if the fix seems to need it, that's a signal
to stop and re-scope as feature-template work instead (SKILL.md Part 0).

Write down which tier you used and why in the plan's Solution/build
approach — "why not the tier above" is often the more informative
sentence than "why this tier."

## Sizing the extraction radius

Radius = **causal path** ∪ **whatever you had to read closely to make
the change safely**. Not more.

- **Include the causal path.** The code the bug/feature actually
  executes through.
- **Include adjacent code you already had to trace.** If understanding
  the fix required reading the validation gating entry into the block
  you're extracting, pull that along — you already paid the
  comprehension cost; leaving it half-attached to the extraction is
  worse than either fully including or fully excluding it.
- **Exclude unrelated responsibilities in the same file/class**, even
  ones you now understand better having been in there. Wanting to clean
  up a neighboring method because you're already in the file is exactly
  the drive-by-rewrite instinct this runbook exists to stop. If a whole
  module clearly needs a real pass, that's a Tier 3 modernization task
  — name it, don't fold it into this fix.
- **When genuinely unsure whether something is on the causal path**,
  leave it out and say so explicitly in the plan's Blast Radius section
  as a known-not-addressed area. Visible-but-skipped beats
  silently-skipped.

## Special case: a `core/` git submodule

Several gainium services ship a private repo that consumes a public
`<service>-sh` counterpart as a `core/` git submodule (e.g.
`app`↔`app-sh`, `exchange-connector`↔`exchange-connector-sh`,
`websocket-connector`↔`websocket-connector-sh`) — check this repo's own
`.gitmodules` and `CLAUDE.md` to see if it's one of them.

If it is:

1. Check whether the file you're touching lives under `core/` before
   assuming a repo-local blast radius — that code is typically
   shared/public and deployed platform-wide, not scoped to this repo.
2. If it does, make the change **inside the submodule checkout**,
   commit there, then bump the pointer in the outer repo deliberately —
   never edit the vendored copy in `core/` and leave the submodule
   pointer stale.
3. If the extraction touches a shape this repo's `CLAUDE.md` documents
   as owned/emitted (API/GraphQL shape, event names/payloads, queue
   names/payloads, a shared DB collection/table read by another service
   with no code link), list every consumer you can identify in the
   plan's Blast Radius — a rename or shape change there breaks
   consumers with no compiler to catch it.
4. The public `-sh` counterpart repos tend to have lighter (sometimes
   absent) test tooling than their private counterparts — see SKILL.md
   Part 5. Follow whatever that specific repo already does; don't add a
   devDependency to solve that as a side effect of an unrelated fix.

## Special case: private git-pinned npm packages

Three gainium repos are libraries consumed elsewhere as npm dependencies
pointing at a git URL rather than a registry version — `@gainium/indicators`,
`@gainium/backtester`, `@gainium/kucoin-api`. This is a different, easier-to-miss
trap than the `core/` submodule case above: `npm ci`/`npm install` alone
**never** bumps a `git+https://...` dependency to the library's latest commit
— only re-running the consumer's own `fullInit` script does (it explicitly
uninstalls then reinstalls the package, which re-resolves to current HEAD and
rewrites the pinned commit hash in `package-lock.json`). A push to one of
these library repos fixes nothing anywhere else until every consumer's
`fullInit` is rerun.

Verified consumption map (check each consumer's own `package.json`
`fullInit` script before trusting this if it's been a while):

| Library | Consumers (own `fullInit` installs it) |
|---|---|
| `indicators` | `app-sh` |
| `backtester` | `app-sh`, `dash`, `main-dash-sh`, `main-dash-redesign` |
| `kucoin-api` | `dash`, `main-dash-sh`, `main-dash-redesign`, `exchange-connector-sh`, `websocket-connector-sh` |

If you fix a bug in one of these three repos, its Blast Radius (SKILL.md
Part 1 gate 3) must list every consumer above and state whether they were
refreshed. The `skills` repo (sibling to this one, source of truth for this
skill itself) has `refresh-consumers.sh` to automate exactly this — see its
README — but running it is a separate, heavier step than the bug fix itself
(real `npm install`s, real pushes to every consumer): don't run it silently
as part of an unrelated change; call it out in the plan and let it be a
visible, deliberate part of the fix.

## Testing the extraction

Every Tier 1/2 extraction gets its own test, in this repo's existing
test idiom (SKILL.md Part 5). This is the payoff: logic that needed a
client mocked to exercise at all now needs one mock (Tier 1) or none
(Tier 2).

## Checklist before calling a JIT extraction done

- [ ] Did Step 0 — looked for and, where one existed, mirrored this
      repo's own existing extraction shape.
- [ ] The extracted module's public surface reads sensibly on its own,
      without the original method's surrounding context.
- [ ] The original call site now calls the extracted module — the logic
      isn't duplicated inline anywhere.
- [ ] Grepped for other call sites of the pattern/constants/magic
      numbers you just extracted — not just the one on today's causal
      path — and pointed them at the extraction too, or explicitly
      noted in Blast Radius why they were left as-is.
- [ ] A test exists for the extracted module and was actually run (not
      just written).
- [ ] If under a `core/` submodule: submodule commit + pointer bump
      done, and cross-service consumers checked.
- [ ] The plan's Solution states the tier used and why; Blast Radius
      states what was deliberately left untouched.
