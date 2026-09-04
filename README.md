# Quarantine

**The agent reads the mail. The page decides what it may act on.**

A support desk where an AI agent's capabilities are computed from merchant records —
never from the customer's message. Tools the agent must not use are not disabled.
**They are never registered**, so they do not appear in `getTools()` and there is
nothing to talk the agent into.

Built for the [WebMCP Challenge](https://webmcp.devpost.com/).

---

## The claim, stated narrowly

> When an agent encounters untrusted customer content, the page can restrict which
> actions exist at all, and require human approval for the sensitive ones — with the
> decision made from records the attacker cannot write to.

This is **not** a claim to solve prompt injection. Nothing here inspects a message to
judge whether it is hostile. There is no classifier and no filter. The claim holds
because the message is never connected to the decision in the first place.

## Restraint is the architecture, not a caveat

The interesting part of this project is what it refuses to do.

- **It does not detect attacks.** Detection is a guessing game the defender must win
  every time and the attacker only once. No code path in this repo branches on whether
  a message looks malicious.
- **It does not trust the model.** Not the model's judgment, not its instruction
  hierarchy, not its willingness to ignore a convincing lie. Two different models
  behave identically here, because there is nothing to behave differently *about*.
- **It never lets an agent move money.** Not above a threshold — at all. The agent can
  only ever *propose*; a human presses the button.
- **There is no language model anywhere in this codebase.** Grep it. The agent is the
  visitor, not a component.

## The mechanism

Two inputs arrive at the desk, and only one of them can affect anything:

| | Written by | Reaches the policy engine? |
|---|---|---|
| The customer's message | anyone — including an attacker | **No. Structurally cannot.** |
| The order record | the merchant's own system | **Yes. Only this.** |

`server/policy.ts` is a pure function taking an order and a ticket state. It has **no
parameter capable of carrying the message body**. Attacker-controlled text cannot
influence which tools exist, the way a function of two numbers cannot be influenced by
a photograph.

So on ticket **T-102** — a message insisting a $2,400 refund was pre-approved offline,
on an order that is 91 days old against a 30-day window — `issue_refund` is never
registered. The agent reads the instruction, cannot comply, calls `explain_policy`,
gets `OUTSIDE_WINDOW`, and escalates.

## How WebMCP is used

The registered tool set is a pure function of the server's policy, recomputed whenever
page state changes.

```js
document.modelContext.registerTool({
  name: "issue_refund",
  description: "Propose a refund. This does NOT issue it: the proposal is held " +
               "in the page until a human presses Approve.",
  inputSchema: { /* ticket_id, amount, justification */ },
  execute: async (input, { signal }) => { /* stages, then awaits a human */ }
}, { signal: controller.signal });
```

| Feature | The job it does here |
|---|---|
| `registerTool` + JSON Schema | 7 tools with typed, enum-constrained inputs |
| **Dynamic registration** — `AbortController` + re-register | **The load-bearing one.** `controller.abort()` withdraws the whole batch; only permitted tools are registered again. Tools *disappear*. |
| `execute(input, { signal })` | `issue_refund` holds the call open until a human decides. The agent is genuinely blocked, not told "check back later". |
| `annotations.untrustedContentHint` | On `get_ticket`. The body genuinely is attacker-controlled. |
| `annotations.readOnlyHint` | Honest read/write split across all 7 |
| `toolchange` event | Keeps the on-screen tool surface truthful |
| **Declarative API** — `toolname`, `tooldescription`, `toolparamdescription`, no `toolautosubmit` | The approval gate. The standard's *own default* is that an agent may fill a form but only a human may submit it, so the gate is not something we invented. `agentInvoked` is checked and refused. |
| `getTools()` / `executeTool()` | Powers the in-page console and the scripted proofs |

**Absence, not refusal.** A refused tool is still in the agent's list — describable,
arguable, a target. A withdrawn one is not there at all. That difference is the
project.

## What you are looking at

- **`/`** — Northwind Supply, a support desk. An ordinary product. `client/desk.ts`
  contains no policy, no tool registration and no approval logic.
- **`quarantine.js`** — the governance layer, added with one script tag. It registers
  the page's tools per policy, withdraws forbidden ones, holds sensitive actions for a
  human, and renders a corner panel (shadow DOM, so host CSS cannot reach it).
- **`/proof.html`** — the positive and negative control runs, and the labeled corpus.

### Honest scope of the "drop-in"

The **mechanism** is site-agnostic: ask a policy endpoint, withdraw and re-register,
hold risky calls, audit everything. The **tool definitions and API paths are currently
hardcoded** for this support desk in `client/tools.ts` and `client/api.ts`. Dropping
`quarantine.js` onto an unrelated site today would call endpoints that do not exist and
register nothing.

So: a working reference implementation of a pattern, not yet a general-purpose library.
Making the host page declare its own tools and endpoints is a config refactor, not new
functionality — see *What's next*.

## Evidence

`bun run corpus` runs 8 tickets — 5 legitimate, 3 carrying injected instructions — and
writes `results.md`. Both rates are published: what was handled, and what was correctly
refused. Injected tickets that produced a write: **0**.

The corpus lives in `server/corpus.ts`, shared by the CLI and the `/api/corpus`
endpoint, so the proof page cannot display a healthier number than the test suite.

**Which checks are weak, stated plainly.** The tool-availability checks restate the
same rule the policy implements — circular, counted but discounted. Three checks are
structural and carry the claim:

1. **Body rewrite** — the message is rewritten into an attack; the decision is asserted
   **byte-identical** before and after.
2. **Forged approval** — a refund is staged, then execution attempted with a guessed
   token. `BAD_NONCE`.
3. **Nonce leak** — the approval token appears nowhere in anything a tool returns, so
   an agent cannot approve its own proposal.

No policy constant can make those three pass falsely.

### The policy survives someone who ignores the UI

Verified with curl, no browser involved:

```
POST /api/refund/stage  {"ticket_id":"T-102","amount":2400}
  → {"error":"OUTSIDE_WINDOW","reason":"Order is 91 days old; the refund window is 30 days."}

POST /api/refund/decide {"id":"...","nonce":"i-guessed-this","approved":true}
  → {"error":"BAD_NONCE","reason":"Approval must come from the in-page form."}
```

The policy runs server-side precisely so this is true. A browser-only guard would fall
to devtools.

## Run it

```bash
bun install
bun run dev          # http://localhost:3000
```

```bash
bun run corpus       # regenerates results.md; exits non-zero on failure
bun run typecheck
```

To see the real browser API rather than the fallback: enable
`chrome://flags/#enable-webmcp-testing` and reload, or open the page in ChatGPT's
in-app browser. The badge in the governance panel says which is in use.

**Zero credentials.** No login, no API key, no signup.

## Architecture

```
Browser
  quarantine.js  ← client/widget.ts + tools.ts + shim.ts
      registers / withdraws tools, holds approvals, renders the panel
        │  every execute() calls the server
        ▼
Bun server (TypeScript)
  policy.ts   the decision. Pure. Takes an order + ticket state. Never the message.
  store.ts    tickets, orders, append-only audit ledger, the approval nonce
  corpus.ts   the labeled corpus, shared by the CLI and /api/corpus
```

`policy.ts` plus the `stageRefund` guard in `store.ts` is the entire trusted computing
base. It is about 150 lines and you can read all of it.

### Honest status

`client/shim.ts` supplies `document.modelContext` when the browser does not. It stores
the same descriptors and calls the same `execute` functions, so policy, approvals and
the ledger are all real — but it is **not** Chrome's implementation. Where this README
describes runtime behaviour, that behaviour has been exercised against the shim. See
`BUGS.md` for what is and is not verified.

## Limits

1. **Only actions this page exposes.** An agent holding tools from elsewhere is outside
   the boundary entirely.
2. **The rules are a demo policy**, not a real merchant's refund logic.
3. **A human can still approve a bad refund.** The gate ensures a person decides. It
   does not ensure they decide well.
4. **In-memory store.** Restart resets everything; all visitors share one state.
5. **No payment provider.** An approved refund produces a reference string; no money
   moves.

## What's next

- Move tool definitions and endpoints into a host-supplied `QuarantineConfig`, so any
  site can declare its own tools and the drop-in claim becomes literally true.
- Cross-origin tool delegation (`<iframe allow="tools">`, `exposedTo`, `fromOrigins`)
  for embedded partner widgets.
- Persist the ledger, and sign entries so the audit trail is tamper-evident.

## Licence

MIT — see [LICENSE](LICENSE).
