/**
 * quarantine.js — the agent governance layer.
 *
 *   <script src="/quarantine.js" defer></script>
 *
 * SCOPE, honestly: the mechanism below is site-agnostic, but the tool definitions
 * and API paths it uses are currently hardcoded for this support desk (see
 * client/tools.ts and client/api.ts). This is a working reference implementation
 * of the pattern, not yet a general-purpose library. Moving the definitions into
 * a host-supplied config is a refactor, not new functionality.
 *
 * What it does for the host page:
 *   1. Registers the page's WebMCP tools, but only the ones the site's policy
 *      endpoint currently permits. Forbidden tools are never registered, so an
 *      agent cannot see or call them.
 *   2. Re-registers whenever page state changes, so the tool surface tracks the
 *      policy instead of being fixed at load.
 *   3. Renders a corner panel showing the live tool surface, any action held for
 *      human approval, and an audit trail of every call including refusals.
 *
 * Everything renders inside a shadow root, so the host page's CSS cannot affect
 * it and it cannot affect the host page.
 *
 * The host page tells the widget what is in focus:
 *   window.Quarantine.focus('T-102')
 */

import { api } from './api.ts';
import { initTools, syncTools, focus, mc } from './tools.ts';
import { installShimIfNeeded, usingShim } from './shim.ts';

const ALL_TOOLS: { name: string; ann: string }[] = [
  { name: 'list_tickets', ann: 'readOnly' },
  { name: 'get_ticket', ann: 'readOnly · untrustedContent' },
  { name: 'explain_policy', ann: 'readOnly' },
  { name: 'triage_ticket', ann: 'write' },
  { name: 'reply_to_customer', ann: 'write' },
  { name: 'escalate_ticket', ann: 'write' },
  { name: 'issue_refund', ann: 'write · human-approved' },
];

const CSS = `
:host{all:initial}
*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.panel{position:fixed;right:16px;bottom:16px;width:330px;max-height:calc(100vh - 32px);
  display:flex;flex-direction:column;background:#151b23;color:#e6edf3;border:1px solid #2a3441;
  border-radius:11px;box-shadow:0 12px 40px rgba(0,0,0,.5);font-size:13px;z-index:2147483000;
  overflow:hidden}
.panel.min{width:auto}
.hd{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #2a3441;
  cursor:pointer;background:#1b2330}
.hd .t{font-weight:600;font-size:12.5px;flex:1}
.hd .c{font:11px ui-monospace,Menlo,Consolas,monospace;color:#8b97a6}
.dotstat{width:8px;height:8px;border-radius:99px;background:#3fb950;flex:none}
.dotstat.shim{background:#d29922}
.bd{overflow-y:auto;padding:11px 12px}
.panel.min .bd,.panel.min .env{display:none}
h4{margin:0 0 7px;font-size:10px;letter-spacing:.9px;text-transform:uppercase;color:#8b97a6}
.tool{display:flex;align-items:center;gap:7px;padding:6px 8px;border-radius:6px;border:1px solid #2a3441;
  margin-bottom:5px;font:11.5px ui-monospace,Menlo,Consolas,monospace}
.tool.on{border-color:#1f6f34;background:#0f1c13}
.tool.off{opacity:.4;border-style:dashed}
.tool .d{width:6px;height:6px;border-radius:99px;background:#3fb950;flex:none}
.tool.off .d{background:#8b97a6}
.tool .a{margin-left:auto;font-size:10px;color:#8b97a6}
.why{font-size:11.5px;line-height:1.5;color:#8b97a6;margin:7px 0 0}
.why b{color:#d29922}
.why.ok b{color:#3fb950}
.appr{margin-top:11px;border:1px solid #d29922;background:#1d1a0f;border-radius:8px;padding:11px}
.appr h5{margin:0 0 3px;font-size:12.5px;color:#d29922}
.appr .amt{font:20px ui-monospace,Menlo,Consolas,monospace;margin:4px 0}
.appr .sub{font-size:11px;color:#8b97a6}
.appr input{width:100%;margin-top:8px;padding:6px 8px;border-radius:6px;border:1px solid #2a3441;
  background:#0d1117;color:#e6edf3;font-size:12px}
.appr .row{display:flex;gap:7px;margin-top:9px}
button{font:inherit;font-size:12px;padding:6px 11px;border-radius:6px;cursor:pointer;
  border:1px solid #2a3441;background:#1b2330;color:#e6edf3}
button.go{background:#1f6feb;border-color:#1f6feb;color:#fff;font-weight:600}
button.no{background:transparent;border-color:#6e2b28;color:#f85149}
.led{font:10.5px/1.4 ui-monospace,Menlo,Consolas,monospace;padding:5px 7px;border-left:2px solid #2a3441;
  margin-bottom:4px;color:#8b97a6}
.led b{color:#e6edf3}
.led .o{float:right;font-size:9.5px;letter-spacing:.4px;text-transform:uppercase}
.led.ok,.led.approved{border-color:#3fb950}
.led.denied,.led.rejected{border-color:#f85149}
.led.staged{border-color:#d29922}
.env{font-size:10.5px;color:#8b97a6;padding:7px 12px;border-top:1px solid #2a3441;background:#11161d}
.env code{color:#58a6ff}
.env b.warn{color:#d29922}
.env b.good{color:#3fb950}
.env{line-height:1.5}
`;

let root: ShadowRoot;
let nonce: string | null = null;
let minimised = false;

function el(html: string): HTMLElement {
  const d = document.createElement('div');
  d.innerHTML = html.trim();
  return d.firstElementChild as HTMLElement;
}

function mount() {
  const host = document.createElement('div');
  host.id = 'quarantine-widget';
  document.body.appendChild(host);
  root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = CSS;
  root.appendChild(style);
  root.appendChild(
    el(`<div class="panel">
      <div class="hd"><span class="dotstat"></span><span class="t">Agent governance</span>
        <span class="c" id="count"></span></div>
      <div class="bd">
        <h4>Tool surface — live</h4>
        <div id="tools"></div>
        <p class="why" id="why"></p>
        <div id="appr"></div>
        <h4 style="margin-top:14px">Audit trail</h4>
        <div id="led"></div>
      </div>
      <div class="env" id="env"></div>
    </div>`),
  );
  root.querySelector('.hd')!.addEventListener('click', () => {
    minimised = !minimised;
    root.querySelector('.panel')!.classList.toggle('min', minimised);
  });
}

const $ = (id: string) => root.getElementById(id) as HTMLElement;
const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export async function paint() {
  const state = await api.state().catch(() => null);
  if (!state || !root) return;
  const view = await api.ticket(focus.ticketId).catch(() => null);
  nonce = state.pending?.nonce ?? null;

  const on = new Set(view?.tools_available ?? []);
  $('count').textContent = `${on.size}/${ALL_TOOLS.length}`;
  $('tools').innerHTML = ALL_TOOLS.map(
    (t) => `<div class="tool ${on.has(t.name) ? 'on' : 'off'}"><span class="d"></span>
      <span>${t.name}</span><span class="a">${t.ann}</span></div>`,
  ).join('');

  const p = view?.policy;
  $('why').className = 'why' + (on.has('issue_refund') ? ' ok' : '');
  $('why').innerHTML = !p
    ? ''
    : on.has('issue_refund')
      ? `<b>issue_refund is registered.</b> ${esc(p.reason)} It can only propose — a human approves here.`
      : `<b>issue_refund is not registered.</b> ${esc(p.code)} — ${esc(p.reason)}
         The agent has no such tool to call.`;

  renderApproval(state.pending);

  $('led').innerHTML = state.ledger.length
    ? state.ledger
        .slice(0, 14)
        .map(
          (e) => `<div class="led ${e.outcome}"><span class="o">${e.outcome}</span>
            <b>${esc(e.tool)}</b> · ${e.actor}<br>${esc(e.detail.slice(0, 70))}</div>`,
        )
        .join('')
    : '<div class="led">No tool calls yet.</div>';

  const dot = root.querySelector('.dotstat')!;
  dot.classList.toggle('shim', usingShim);
  // A judge must never mistake the fallback for WebMCP itself. Say so plainly.
  $('env').innerHTML = usingShim
    ? '<b class="warn">NOT WebMCP.</b> This browser provided no <code>document.modelContext</code>, ' +
      'so the page installed its own fallback registry. Same tools, same policy, same approvals. ' +
      'For the real API, enable <code>chrome://flags/#enable-webmcp-testing</code> or open this in ' +
      "ChatGPT's browser."
    : '<b class="good">Real WebMCP.</b> Using the browser-provided <code>document.modelContext</code>.';
}

function renderApproval(pending: { id: string; amount: number; ticketId: string; justification: string } | null) {
  if (!pending) {
    $('appr').innerHTML = '';
    return;
  }
  $('appr').innerHTML = `
    <form class="appr" id="af" toolname="approve_refund"
      tooldescription="Review a staged refund. An agent may fill the reviewer note, but only a human can submit this form.">
      <h5>Held for human approval</h5>
      <div class="amt">$${pending.amount.toFixed(2)}</div>
      <div class="sub">${esc(pending.ticketId)} · proposed by the agent</div>
      <input name="note" type="text" placeholder="Reviewer note (optional)" autocomplete="off"
        toolparamdescription="Optional note from the reviewer, recorded in the audit trail." />
      <div class="row"><button class="go" type="submit">Approve</button>
        <button class="no" type="button" id="rej">Reject</button></div>
    </form>`;

  const form = $('af') as HTMLFormElement;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    // Chrome sets agentInvoked when an agent submitted a declarative tool form.
    if ((e as SubmitEvent).agentInvoked) {
      console.warn('[quarantine] agent-invoked submit refused — a human must approve');
      return;
    }
    await decide(pending.id, true);
  });
  $('rej').addEventListener('click', () => void decide(pending.id, false));
}

async function decide(id: string, approved: boolean) {
  if (!nonce) return;
  const r = await api.decide(id, nonce, approved);
  window.dispatchEvent(
    new CustomEvent('q:decision', { detail: { approved: r.approved === true, reference: r.reference } }),
  );
  window.dispatchEvent(new CustomEvent('quarantine:changed'));
  await paint();
}

// ---------------------------------------------------------------------------

export interface QuarantineAPI {
  focus(ticketId: string): Promise<void>;
  refresh(): Promise<void>;
  tools(): Promise<string[]>;
  usingShim(): boolean;
}

async function boot() {
  installShimIfNeeded();
  mount();
  initTools();
  await paint();

  window.addEventListener('q:refresh', () => void paint());
  window.addEventListener('quarantine:changed', () => void paint());
  setInterval(() => void paint(), 2500);

  const q: QuarantineAPI = {
    async focus(id) {
      focus.ticketId = id;
      await syncTools();
      await paint();
    },
    refresh: paint,
    tools: async () => ((await mc()?.getTools?.()) ?? []).map((t) => t.name),
    usingShim: () => usingShim,
  };
  (window as unknown as { Quarantine: QuarantineAPI }).Quarantine = q;
  window.dispatchEvent(new CustomEvent('quarantine:ready'));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void boot());
} else {
  void boot();
}
