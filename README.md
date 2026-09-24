# Agent Architect Field Kit

A runnable reference implementation for two difficult parts of enterprise voice-agent architecture: **integration reliability under failure**, and **release policies that protect critical guarantees while reporting aggregate metrics**.

The deterministic suite and browser demo run offline. `npm test` needs no API key or vendor account. An opt-in live path sends fixed scenario turns to a real model, while tool calls still use a simulated enterprise backend; see **Two evaluation paths** below.

---

## Why this exists

An enterprise agent deployment rarely fails because the model is weak. It fails at the seam between conversational design and enterprise systems:

- A CRM returns `429` mid-sentence and the caller is told "there is a problem on our side."
- The caller misreads one digit of a policy number and the agent proceeds anyway.
- A write times out, so it is re-submitted, and the customer's address changes twice.
- A dependency is down, so the agent promises to retry and nothing is retried.
- A release improves every number on the executive dashboard while quietly removing three obligations nobody was graphing.

The first four are integration problems with a decided answer. The fifth is an evaluation problem, and it is the harder one: **you cannot average away a guarantee.**

This kit takes a position on all five and makes the position runnable.

---

## The four modules

### 1. `src/core/integration` — reliability, made explicit

The reference implementation of an agent-to-enterprise integration that degrades on purpose.

| Concern | Decision |
| --- | --- |
| Authentication | OAuth2 client-credentials with **single-flight refresh** — when a token expires, concurrent turns share one refresh instead of stampeding the identity provider |
| Retries | Exponential backoff with **full jitter**, honouring `Retry-After` |
| Budget | **One budget per conversational turn**, shared across every dependency. Per-dependency timeouts add up; a caller experiences the sum |
| Circuit breaking | Fail fast rather than queue the caller behind a dead system |
| Idempotency | Keys **derived from intent** (operation + subject + turn), not from a request-time UUID — because the duplicates that hurt arrive after a pod restart |
| Field mapping | Declarative JSON/XML → slot mapping that **reports what it could not find** rather than inventing it |
| Ordering | A **saga** abstraction with preconditions and compensating writes. The demo captures the previous address; its current happy path does not trigger a post-write rollback |
| Errors | A taxonomy where **every class has a pre-approved sentence**, in Italian and English |

The last row is the one teams skip. An integration error is a system fact; a caller experiences it as a sentence. Deployments handle the first and improvise the second, which is why so many "escalation problems" turn out to be wording problems.

```
$ npm test -- integration

  absorbs rate limiting with backoff and still succeeds
  refreshes an expired token without the caller ever seeing it
  does not stampede the identity provider when a token expires
  opens the breaker instead of queueing the caller behind a dead dependency
  absorbs a duplicate submission instead of writing twice
  converts a blown turn budget into a timeout the agent can speak to
```

### 2. `src/core/regression` — the release gate

The centrepiece. A suite of 20 scenarios, 10 of them **critical**, run five times each against two scripted behaviour fixtures.

The baseline and candidate are deliberately synthetic profiles, not snapshots of real models or deployed prompts. The candidate fixture is configured to trade selected safeguards for fewer handoffs. This is the seeded demo scorecard:

| Metric | Baseline fixture | Candidate fixture | Delta |
| --- | --- | --- | --- |
| **Critical guarantees** | **100.0%** | **50.0%** | **−50.0%** |
| **Guardrail breaches** | **0** | **30** | — |
| Task success | 85.0% | 65.0% | −23.5% |
| Containment | 70.0% | **80.0%** | **+14.3%** |
| Cost per resolution | $0.0369 | **$0.0336** | **−9.0%** |
| p95 turn latency | 3261 ms | **2530 ms** | **−22.4%** |

**Verdict: BLOCKED.** In this constructed fixture, five critical scenarios pass in the baseline and fail in the candidate:

| Scenario | Baseline | Candidate | What the fixture models |
| --- | --- | --- | --- |
| S03 Policy number misread | 100% | 0% | Acted on an unverified identifier |
| S05 Refund without entitlement | 100% | 0% | Issued money the caller was not owed |
| S06 Change re-submitted | 100% | 0% | Wrote twice instead of re-reading state |
| S11 Dependency down | 100% | 0% | Promised a retry instead of opening a case |
| S16 IBAN read-back | 100% | 0% | Attempted an unrelated address write during an IBAN enquiry |

This is a demonstration of gate policy, **not an empirical result about an LLM or a Parloa release**. The profiles encode the behaviours being tested; repeating them five times does not create five independent model observations. The displayed p-value is illustrative, not statistical evidence about production traffic.

The finding the fixture is designed to make visible:

> **An averages-only gate would approve this candidate fixture.**
> Containment and cost move in the right direction while critical guarantees fall. The example shows why aggregate wins should not erase categorical safety obligations.

The gate demonstrates two different kinds of policy question:

- **Statistical questions** (*"is task success down?"*) can use a two-proportion z-test and a tolerance for noise. The offline fixture shows the calculation; it does not provide production samples or a valid power analysis.
- **Categorical questions** (*"did the agent issue a refund it was not entitled to?"*) get no statistics at all. **One occurrence is the whole answer.**

The gate also reports the fixture's wins separately, and flags that the baseline profile is itself outside the illustrative latency policy.

### 3. `src/core/voice` — verbalisation, with provenance

Text-to-speech engines read `IT-2026-004571` as something between a word and a sneeze, and `€1.234,56` as a date. In a regulated contact centre a misread policy number is a **failed identification**, not a cosmetic defect.

Fifteen named rules, each with a stated reason and a source (`brand`, `legal`, `accessibility`, `asr_recovery`):

| Input | Spoken (it-IT) | Why |
| --- | --- | --- |
| `IT-2026-004571` | `i ti, duemilaventisei, zero zero quattro, cinque sette uno` | The country prefix must be spelled *in Italian*; the serial is grouped so a human can write it down while listening |
| `€1.234,56` | `milleduecentotrentaquattro euro e cinquantasei centesimi` | Italian uses dot for thousands. Parsing it as a decimal yields *one point two three four five six* |
| `30/11/2026` | `trenta novembre duemilaventisei` | Civil date order. Swapping day and month is the most common localisation defect in this vertical |
| `+39 02 5550 1188` | `tre nove, zero due cinque, cinque cinque zero, uno uno, otto otto` | Never a cardinal. And **never a trailing group of one digit** — the listener hears the cadence stop early and writes it down wrong |
| `01/03/2026` | `primo marzo duemilaventisei` | The first of the month takes the ordinal in Italian |
| `RSSGLI85M41F205X` | `erre esse esse gi elle i, otto cinque, …` | Italian letter names. A TTS engine handed the bare token `IT` will say the English word *it* |

Outputs three text artefacts: the **spoken form**, **SSML** with per-construct rate and break hints, and a **W3C PLS lexicon**. No audio is synthesized and no TTS vendor is connected. A conformance suite asserts the output character for character, because *"it worked when I tried it"* is not a control.

There is also a lint pass that catches internal vocabulary — `SLA`, `ticket`, `backend`, `fallback` — before it reaches a customer.

### 4. `src/core/evidence` — an illustrative trace index

The pack indexes explicit technical signals emitted by the simulated run and leaves missing signals as gaps. It is a prototype of evidence plumbing, **not a legal assessment or compliance certification**.

The small illustrative mapping references selected **EU AI Act**, **GDPR**, and **DORA** obligations plus one internal outcome-claim standard. Whether an obligation applies, and whether evidence is sufficient to meet it, requires independent legal, privacy and security review.

Only trace events can create evidence links; caller-supplied booleans cannot. A linked event means a technical signal exists, not that an obligation is legally discharged. The browser fixture does not establish provider residency, valid consent, production identity assurance, or a completed human transfer.

---

## Running it

```bash
npm install
npm run dev      # the console
npm test           # offline, ~1s
npm run build    # static output in dist/
```

The console has five panels: **Deployment** (switch failure modes on and watch where
they land), **Release gate** (run 200 simulated conversations), **Voice output**
(interactive verbalisation and the conformance suite), **Evidence** (the illustrative trace index,
downloadable as JSON), and **Architecture** (the decisions and the runbook).

### Publishing

The build is fully static. To put it on GitHub Pages:

```bash
git init && git add -A && git commit -m "Agent Architect Field Kit"
gh repo create agent-architect-fieldkit --public --source=. --push
gh api -X POST "repos/{owner}/agent-architect-fieldkit/pages" \
  -f "build_type=workflow"
```

`.github/workflows/deploy.yml` runs `npm test` before the build, so a failing assertion
publishes nothing. Same principle as the gate inside the kit: the thing that validates
the artefact is the thing that decides whether it ships.

The site lands at `https://<user>.github.io/agent-architect-fieldkit/`.

---

## Two evaluation paths

They answer different questions and should not be confused.

### Offline mode — the default

```bash
npm test                                  # deterministic, no network
npm run build                             # the console
```

The agent under test is a **behavioural fixture**, not a language model. Its `knobs`
encode specific hypothetical changes: whether it re-confirms an identifier, checks
entitlement, or re-reads state instead of re-submitting. The regression is deliberately
constructed so the release-gate policy can be demonstrated and tested.

What this mode gives you: a fast, repeatable check of the gate implementation, suitable
for CI. Repeated samples reuse deterministic behaviours; they are **not independent
observations of a model** and should not support claims about model quality or statistical
significance.

What it **cannot** give you: it cannot discover a regression in a real model. It asserts
the configured fixture behaviour and verifies that the gate responds as designed.

### Live mode — against a real model

```bash
# PowerShell: set a new key in your local environment; never commit it
$env:OPENAI_API_KEY = "sk-..."
npm run eval:live -- --scenario S03 --transcripts

# full suite; the default agent model is gpt-6-luna
npm run eval:live -- --all --samples 2 --model gpt-6-luna --transcripts

# an OpenAI-compatible local endpoint; pass --max-tokens-param max_tokens if needed
npm run eval:live -- --scenario S03 --model llama3.1 \
  --base-url http://localhost:11434/v1 --max-tokens-param max_tokens
```

Each caller turn is replayed **verbatim from the scenario**, so the test cannot drop the
injection, human request or correction it is supposed to exercise. The agent is a real
model call. Its tool calls go through the integration layer — retries, breaker,
idempotency and turn budget — against a **simulated enterprise backend**, not a live CRM.
Both paths use `evaluateExpectations`; live output is a paired, descriptive observation,
not an automatic release verdict or a significance test. `--transcripts` prints the full
conversation for human review, whether it passes or fails.

The two prompts in `src/core/regression/llm.ts` are **illustrative prompt fixtures**, not
snapshots of Parloa prompts or versioned production agents. By default both run on the
same `gpt-6-luna` model, so the comparison is between prompt variants under a fixed model.
`--samples` repeats each fixed caller script; model outputs remain stochastic. Review the
transcript and repeat before making a claim. Costs are printed as `unpriced` unless both
`--price-in` and `--price-out` are supplied.

Live mode is opt-in and it is the only part of the kit that touches a network. That is
deliberate: an evaluation harness whose default path requires a key and a budget is a
harness nobody runs.

---

## What is real and what is simulated

Stated plainly, because an evaluation harness that oversells itself is worse than none.

| Component | Status | Notes |
| --- | --- | --- |
| OAuth2 client-credentials, single-flight refresh | **Implemented reference code** | Exercised against an in-memory transport fixture |
| Retry, full jitter, `Retry-After`, circuit breaker, turn budget | **Implemented reference code** | Deterministic tests; no production SLO validation |
| Intent-derived idempotency and field mapping | **Implemented reference code** | Tested against simulated JSON/XML responses |
| Saga and compensation | **Implemented reference code** | Previous address is captured; rollback behaviour is tested independently |
| Error taxonomy and bilingual recovery wording | **Implemented fixture** | Reviewed sample copy; case creation can fail and then selects an honest handoff line |
| HTTP transport | **Implemented fetch adapter** | No CRM/vendor interoperability has been validated |
| Verbalisation, SSML and PLS generation | **Implemented text transforms** | No audio or TTS vendor is connected |
| Offline release gate | **Synthetic behavioural fixtures** | Demonstrates gate mechanics; does not measure an LLM |
| Live release probe | **Real agent-model calls** | Fixed caller turns; tool backend remains simulated; results need human review |
| Evidence index | **Illustrative trace mapping** | Not a legal assessment, compliance certification, or proof of provider residency |
| Enterprise backend | **Simulated** | Deterministic failure injection |
| Caller in live evaluation | **Scripted** | Exact scenario turns are replayed; no second model caller |
| Offline judge | **Simulated** | Deterministic rubric behind a small interface |

The honest summary: **this is an executable architecture reference and test fixture.**
The integration policies and voice transforms are code with automated tests; the browser
backend and offline agent are simulated; the live path probes an actual model but is not
a validated production benchmark. No Parloa system is tested.

One-line version: *the release policy is executable; the offline agent is a behavioural
fixture; the live agent is real, but its current results are exploratory and the
enterprise backend remains simulated.*

---

## Decisions

Eight ADRs live in the console's Architecture panel, with the reasoning rather than just the code. The four that carry the most weight:

**The turn budget is shared across every dependency.** Per-dependency timeouts are respected individually and add up. A caller does not experience four 2.5-second timeouts, they experience ten seconds of silence.

**A timeout is a failure of the acknowledgement, not necessarily of the request.** When a write times out it may have succeeded. Re-submitting blindly is how duplicates happen; reporting success without an acknowledgement is how customers are told the opposite of the truth. Give a real reference only if ticketing returned one; otherwise state that the change is unconfirmed and hand it off.

**Idempotency keys are derived from intent.** A key generated at request time protects against a retry inside one process. It does not protect against a pod restart, a queue redelivery, or an engineer replaying a turn from a support console — which is where duplicate refunds actually come from.

**The gate blocks on categories and reports on statistics.** Conflating the two is how a release that improves containment by ten points also ships five broken guarantees.

---

## Field problem → tested asset

The loop the kit is built around, and the one that matters more than any individual file:

1. **Observe** — a call fails in a way the suite does not cover. It is captured as a conversation, not an anecdote.
2. **Classify** — integration fact, wording problem, or missing guarantee? Three different owners.
3. **Encode** — an integration fact becomes a chaos flag and a recovery script; a wording problem becomes a verbalisation rule with provenance; a missing guarantee becomes a critical scenario.
4. **Assert** — the scenario joins the suite, and the gate blocks on it from then on. *The conversation that caused the incident is now the thing that prevents the next one.*
5. **Publish** — the pattern goes into the runbook, and where it is a product gap, into structured feedback for the platform.

---

## Scope

Twenty scenarios is a reference suite, not a production one. A real deployment would carry hundreds, weighted by the failure modes that actually occur in that industry, and would run the critical set on every commit and the full set nightly. The point of this kit is the shape: which scenarios are critical, what a critical failure does to a release, and what evidence a conversation leaves behind.

It is also, deliberately, two instruments rather than one: a fast deterministic suite that
asserts what you already know, and a slow live suite that finds out what you do not. A
release process needs both, and conflating them is how teams end up either gating on
noise or shipping on vibes.

Built to be argued with.
