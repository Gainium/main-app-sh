---
name: gainium-dev-flow
description: Gainium-specific development workflow — spec-driven gates for every change (feature or bug fix), with a bug-flavored spec template (definition, evidence, assumption) and a blast-radius-checking plan when the standard feature template doesn't fit, SOLID applied per this repo's own architectural pattern, and just-in-time extraction of legacy spaghetti (domain logic mixed with I/O) instead of full rewrites. Use whenever starting work in a gainium repo: fixing a bug, adding a feature, planning a change, deciding whether code needs a test, or deciding how much of a legacy file to pull apart while you're in there. Trigger on phrasing like "fix this bug", "spec this out", "write the plan first", "where should this go", "this touches legacy code", "is this pure/domain or infra", or "how much should I extract".
---

# Gainium dev flow

This skill is distributed into every gainium repo — you're reading the
copy that lives in *this* repo. It intentionally contains **no file
paths or examples specific to another repo** (no `app`/`app-sh`
references): someone working in `exchange-connector` won't have `app`
checked out, and different repos use different frameworks (main-app's
hand-rolled COP singletons vs. NestJS providers elsewhere) and different
test tooling (mocha, Jest, hand-rolled `expect()` scripts all exist
across gainium repos — don't assume any one of them). Wherever this
file needs a concrete example, it tells you to go find *this repo's*
own, not to copy one from memory of another repo.

Two things changed here versus a generic spec-driven/hexagonal skill:

1. **Bug fixes go through the same seven gates as features**, not a
   shortcut. The only fork is *what the spec (gate 1) contains* — a bug
   doesn't have new behaviour to define, it has existing behaviour to
   diagnose. See Part 1's two spec templates. The harness's plan-mode UI
   only gates *approval* of what you write — it does not gather
   evidence, trace logs, or reproduce a bug for you. That's the agent's
   job, done during gates 1–2, and it still gets written into a real
   persisted `specs/NNN.slug.md`, exactly like a feature.
2. **This repo is probably not hexagonal today.** Business rules are
   probably mixed with DB/queue/exchange/HTTP calls in the same
   function or class, wherever that pattern already exists here (check
   this repo's own `CLAUDE.md` for its documented architecture). New
   code should still be designed with SOLID + narrow ports (Part 3).
   Existing code gets modernized **just-in-time, only where you're
   already touching it** — never a drive-by rewrite. That extraction
   method is detailed in
   [JIT-LEGACY-EXTRACTION-RUNBOOK.md](JIT-LEGACY-EXTRACTION-RUNBOOK.md);
   read it before doing any legacy touch-up, don't re-derive it here.

**Repo layout note:** Every artefact this skill produces (`specs/`,
`plans/`) lives inside **this repo**, not some shared location — never
at the gainium root. If this repo has a `core/` git submodule (check
`.gitmodules` — a common gainium pattern: `app`↔`app-sh`,
`exchange-connector`↔`exchange-connector-sh`, `websocket-connector`↔
`websocket-connector-sh`, and others), treat files under `core/` as
shared/public/deployed-platform-wide even though you're sitting in the
private counterpart repo — see Part 1's Blast Radius guidance and the
runbook's special case for this.

---

## Part 0 — Which spec template

Every change — bug or feature — goes through all seven gates below.
The only decision up front is which **spec template** gate 1 uses:

| Situation | Spec template |
|---|---|
| Existing behaviour is wrong; you're fixing it | **Bug spec** — Definition / Evidence / Assumption |
| Behaviour doesn't exist yet; you're defining something new | **Feature spec** — behaviour description + open questions |

A small addition inside an existing legacy module is usually closer to
a bug spec (there's a concrete "what's the current/expected behaviour"
to pin down) than a feature spec — use judgement, but default to the
bug template for anything landing inside code that already exists.

---

## Part 1 — The seven gates

| # | Gate | Artefact | Done when |
|---|------|----------|-----------|
| 1 | **Spec** | `specs/NNN.slug.md` | Written using the right template (Part 0). Numbered sections (`§5.4`) — gate 2's tests cite them. Open questions/assumptions are *listed*, not silently resolved. |
| 2 | **Test by spec** | tests, in this repo's existing test idiom (Part 5) | Written from the spec, before implementation, and they fail (red) **for the reason the spec states**, not incidentally. |
| 3 | **Plan** | `plans/NNN.slug.md` | Build order, contract decisions the spec left open, a **Blast Radius** subsection (always present — see below), and a spec-section → test-file traceability table. |
| 4 | **Verify plan against spec** | — | Walk the spec; every section appears in the traceability table; every plan decision was actually left open by the spec (for a bug: the plan is fixing the root cause the spec's Assumption names, not a different, easier one). Disagreements resolved **in the spec**, never silently patched into the plan. |
| 5 | **Do** | code | Implement until red tests go green. If the causal path runs through legacy spaghetti, follow [JIT-LEGACY-EXTRACTION-RUNBOOK.md](JIT-LEGACY-EXTRACTION-RUNBOOK.md). Never edit a test to make it pass. |
| 6 | **Test** | green suite | Everything green — this is the guarantee the fix/feature actually works. See Part 5 for this repo's runner. |
| 7 | **Eval** | eval / review report | Only for non-deterministic or quality-judged output (LLM prompts, ranking). Skip for deterministic changes where gate 6 already proves correctness — most bug fixes. |

Gate 4 is the one people drop — treat it as an explicit step.

### Gate 1 — the two spec templates

**Feature spec template** (new behaviour): describe behaviour in domain
terms, not schema/infra terms — "a bot's stop price must never cross
its take-profit price," not "the `bots` collection has a check on
`stopPrice`." List open questions rather than resolving them silently.

**Bug spec template** (existing behaviour is wrong) — three required
sections, in order:

- **Definition.** Expected behaviour vs. actual behaviour, precisely.
  This is the spec — "correct" is being defined by what should have
  happened, even though the code already exists.
- **Evidence.** What actually shows the Definition's "actual" side is
  true: logs, a traced code path, a reproduction. Go get this yourself
  — read logs, reproduce it, step through the code. The harness does
  not supply it; a spec built on an unverified guess is not a spec.
- **Assumption.** Your root-cause hypothesis, stated explicitly and
  flagged as hypothesis, not fact. Gate 2's test must fail *because*
  this assumption is true, not for some other incidental reason — if it
  doesn't, the assumption is wrong and you're not done with gate 1 yet.

### Gate 2 — test by spec

Each test cites the spec section it enforces. For a bug, the test
reproduces the Definition's expected-vs-actual gap and must fail for
the reason named in Assumption — if a test fails for a different reason
(wrong path, unrelated exception), the Assumption was wrong; go back
and revise the spec, don't patch the test to fail "somehow." The test
is presumed right once implementation exists; changing it afterward is
only legitimate to fix a race, a wrong path, or a shape the spec never
pinned down.

### Gate 3 — plan, and the Blast Radius subsection

Cover build order across every affected service this change spans.
Resolve contract decisions the spec left open (the plan may *decide*
those — it may not invent new ones). For a bug, state which JIT
extraction tier (runbook) you're applying to the touched legacy code,
and why not a lower or higher one. Build the spec-section → test-file
traceability table.

**Blast Radius is a required plan subsection, every time**, though for
a genuinely greenfield new module it may be short ("none — new file, no
existing callers"). Check, in order:
1. Other call sites of the function/method/pattern you're changing —
   grep before claiming there are none.
2. Whether the touched file is under this repo's `core/` submodule (if
   it has one) — shared/public/deployed-platform-wide, not repo-local.
   The submodule pointer needs bumping deliberately afterward.
3. Whether the change touches something this repo's own `CLAUDE.md`
   documents as owned/emitted (API/GraphQL shape, event names/payloads,
   queue names/payloads, a shared DB collection/table read by another
   service with no code link) — every gainium repo's `CLAUDE.md` has a
   section like this, worded differently per repo ("Cross-service
   contracts", "OWNS/EMITS", "Rules", ...). A shape change there breaks
   consumers with no compiler to catch it.
4. Which other tests, beyond the new one, exercise this path and must
   stay green.

### Gate 4 — verify plan against spec

Walk the spec section by section; confirm coverage in the traceability
table; confirm every plan decision was actually left open by the spec.
For a bug specifically: confirm the plan's Solution is fixing the root
cause the spec's Assumption names — a plan that fixes a symptom instead
of the named cause is a spec disagreement, not a plan detail. Resolve
disagreements by editing the spec, never by quietly adjusting the plan
to match what's easiest to build.

### Gate 5 — do

Implement until gate 2's tests go green. If a test looks wrong
mid-implementation, stop and raise it as a spec question instead of
editing the test to unblock yourself.

### Gate 6 — test

Full suite green, in every repo touched, using this repo's actual
runner (Part 5) — this is the guarantee, not a formality. If this repo
has a version-bump + changelog release ceremony documented in its own
`CLAUDE.md`, that's an exit criterion for this gate too; this skill
doesn't repeat that detail, just enforces it.

### Gate 7 — eval

For LLM prompts, ranking, or anything else judged on quality rather
than pass/fail: run against real inputs, read the sample output
yourself. Skip entirely for deterministic changes.

### Naming a spec and its plan

- `NNN.slug.md`, identical in both `specs/` and `plans/`, **in this
  repo**.
- Numbers come from one sequence per repo, shared by `specs/` and
  `plans/`, never reused. Before claiming a number: list both dirs
  **and** `git branch -a` — a number claimed on an unmerged branch
  isn't free.
- Slug names the change, not the layer: `hedge-bot-shared-settings` or
  `stop-price-race-on-partial-fill`, not `backend-fixes`.

---

## Part 2 — SOLID, applied

A design lens, not a checklist to satisfy line-by-line.

- **Single Responsibility.** A class/service is allowed to orchestrate
  many things — that's often its job — but a single *method* mixing a
  business decision with several different I/O calls is doing two
  jobs. That's the seam Part 4/the runbook cuts along.
- **Open/Closed.** A new variant (a new exchange, a new notification
  channel, a new bot type) is a new implementation behind an existing
  interface, not a new `if (x === 'y')` branch bolted into shared code.
- **Liskov Substitution.** Any two implementations behind the same
  interface must be interchangeable — neither should throw on an input
  the interface's contract allows, or silently narrow what it promised.
  If two implementations don't behave identically for the same method,
  the interface is underspecified.
- **Interface Segregation.** Prefer a narrow, purpose-specific interface
  over one fat interface every implementer must fill in full just to
  use one piece of it.
- **Dependency Inversion.** Pure/decision code never imports a DB
  client, queue client, or exchange SDK directly — it depends on data
  passed in or an interface it owns. This is the principle Part 3 and
  the runbook both exist to enforce, one for new code, one for legacy.

---

## Part 3 — Layering for genuinely new code

Goal: swapping one DB/exchange/provider for another stays a change
confined to one place, not a scavenger hunt.

**Follow this repo's own documented orchestration pattern** for how
services are composed (check its `CLAUDE.md`'s architecture section —
gainium repos differ here: some use hand-rolled singleton services,
some use a framework's own DI/module system). This skill does not
prescribe one pattern over another. What it prescribes is what lives
*inside* whatever unit that pattern gives you:

```
Orchestration unit (this repo's own pattern — a service class, a DI
provider, whatever)
  — composes things, owns runtime state, decides *when* things happen.
    Method bodies call out to pure decision functions and to
    injected/imported adapters — they don't inline either kind of logic
    themselves.

Pure decision modules
  — plain functions/types only. No DB client, no queue client, no HTTP
    client, no framework import. Business rules, calculations,
    validation, invariant checks. Independently testable with no
    mocking.

Adapters
  — concrete I/O: a DB/model layer, an exchange REST/WS client, a queue
    publisher, an HTTP client. Implement a narrow interface (the port)
    expressed in domain terms — `FeeSource.currentFee(symbol)`, not
    `client.get('fee:'+symbol)`.
```

**Dependencies point inward.** A pure decision module depends on
nothing. An orchestration unit may depend on decision modules and on
port interfaces (injected or imported). An adapter depends on the
interface it implements. A decision module never depends on an adapter
or an orchestration unit.

### A quick check that the boundary is holding

Grep the specific file you just extracted for driver imports it
shouldn't have — adjust the pattern to what this repo actually uses
(check its `package.json` dependencies for the real driver/client
names):

```bash
grep -lE "<this repo's db/queue/http client names>" path/to/extracted-module.ts   # must be empty if you called it pure
```

If a module you called "pure" fails this check, it's Tier 1
(extracted-but-coupled) per the runbook, not Tier 2 — that's fine, just
don't call it pure in the plan's Solution section.

### Signs the boundary is already leaking

- A decision function takes a DB document or a client SDK's response
  type as a parameter instead of a plain domain shape.
- An orchestration method catches a driver-specific error type instead
  of the adapter translating it to a domain-level error first.
- A business rule is expressed as a DB query filter instead of as logic
  that happens to be backed by a query for performance.
- A port interface has a method that exists only because one specific
  adapter's API shape needed it — that's the adapter's problem.

### Applying this inside the gate flow

- **Gate 1 (spec):** domain terms, not schema/infra terms.
- **Gate 3 (plan):** name new ports explicitly and which adapter(s)
  implement them — that's a gate-4-checkable "contract decision the
  spec left open."
- **Gate 5 (do):** reaching for a driver type inside a decision module
  means the port is missing a method, not a reason to reach past it.

---

## Part 4 — Touching legacy code

Any change whose causal path runs through existing code that mixes
decision logic with I/O follows the just-in-time extraction method in
**[JIT-LEGACY-EXTRACTION-RUNBOOK.md](JIT-LEGACY-EXTRACTION-RUNBOOK.md)**
— read it, don't guess at the ladder from this summary:

- Tier 0: not on the causal path → leave it alone.
- Tier 1: pull it into its own named, tested module even if it stays
  infra-coupled.
- Tier 2: go fully pure where the logic naturally allows it.
- Tier 3: full ports-and-adapters (Part 3) — only for a deliberate
  modernization task or genuinely new code, never sprung on a legacy
  bug touch.

Pick the **lowest** tier that actually removes the smell on the path
you're touching. The runbook has the radius-sizing rule (what counts as
"already being touched" vs. scope creep), how to find this repo's own
existing examples of each tier before inventing a new shape, and the
`core/`-submodule special case.

---

## Part 5 — Tests are not optional

Every bug fix and every feature ships a test that fails before the
change and passes after (gate 2), and stays green after (gate 6).
"This repo has no test runner" is not an exemption — it changes *how*
you write the test, not *whether*.

**Before writing a test:** check this repo's `package.json` for a test
runner/script, and open the nearest existing test file as a template.
Gainium repos are not consistent here — some have a real runner (mocha,
Jest, ...) with a conventional test directory or naming scheme; some
have no runner at all and use hand-rolled comparator scripts run
directly via `ts-node` with the exact run command in a header comment.
Match whatever this repo already does. If this repo has no tests at
all yet, that's itself worth flagging in the plan rather than silently
picking a framework — introducing a new devDependency is a bigger call
than the fix at hand, especially in a public/shared repo; recommend it,
don't do it unasked.

An extraction done per Part 4 gets its own test in this repo's idiom —
that's what makes the extraction pay for itself: logic that needed
mocking three clients to exercise now needs one (Tier 1) or none
(Tier 2).
