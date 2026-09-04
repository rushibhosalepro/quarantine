/**
 * The support desk itself — an ordinary helpdesk UI.
 *
 * Note what is NOT in this file: no policy, no tool registration, no approval
 * logic. This is just a product. The governance layer arrives via one script tag
 * (quarantine.js) and the desk does not know it is there, which is the point of
 * shipping it as a drop-in.
 */

import { api, type AppState, type TicketView } from './api.ts';

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const initials = (n: string) =>
  n.replace(/[^A-Za-z ]/g, '').trim().split(/\s+/).map((w) => w[0] ?? '').slice(0, 2).join('').toUpperCase() || '?';

let selected = 'T-101';
let snapshot = '';

const Q = () => (window as unknown as { Quarantine?: { focus(id: string): Promise<void> } }).Quarantine;

async function refresh() {
  const state = await api.state().catch(() => null);
  if (!state) return;
  const view = await api.ticket(selected).catch(() => null);
  const snap = JSON.stringify([state.tickets, view]);
  if (snap === snapshot) return;
  snapshot = snap;
  renderQueue(state);
  if (view) renderThread(view);
}

function renderQueue(state: AppState) {
  $('tickets').innerHTML = state.tickets
    .map(
      (t) => `<div class="tick ${t.id === selected ? 'sel' : ''}" data-id="${t.id}">
        <div class="sub">${esc(t.subject)}</div>
        <div class="prev">${esc(t.customer)}</div>
        <div class="meta"><span class="pill ${t.state}">${t.state}</span><span>${esc(t.id)}</span></div>
      </div>`,
    )
    .join('');
  $('tickets')
    .querySelectorAll<HTMLElement>('.tick')
    .forEach((el) =>
      el.addEventListener('click', async () => {
        selected = el.dataset.id!;
        snapshot = '';
        await Q()?.focus(selected);
        await refresh();
      }),
    );
}

function renderThread(v: TicketView) {
  const o = v.order;
  const outcome = v.refund
    ? `<div class="outcome resolved"><b>Refund issued — ${esc(v.refund.reference)}</b>
        $${v.refund.amount.toFixed(2)}, approved by a human in this page.</div>`
    : v.escalation_reason
      ? `<div class="outcome escalated"><b>Escalated to a human agent</b>${esc(v.escalation_reason)}</div>`
      : '';

  const reply = v.reply
    ? `<div class="msg agent"><div class="av">AI</div><div class="bub">
        <div class="from"><b>Support assistant</b><span class="src">sent via reply_to_customer</span></div>
        <pre>${esc(v.reply)}</pre></div></div>`
    : '';

  $('thread').innerHTML = `
    <h2 class="subject">${esc(v.subject)}</h2>
    <div class="crumbs"><span class="pill ${v.state}">${v.state}</span>
      <span>${esc(v.id)}</span><span>·</span><span>${esc(v.customer)}</span></div>

    ${o ? `<div class="order"><h3>Order record — merchant system</h3><div class="grid">
      <div class="f"><b>Order</b><span>${esc(o.id)}</span></div>
      <div class="f"><b>Total</b><span>$${o.total.toFixed(2)}</span></div>
      <div class="f"><b>Status</b><span>${esc(o.status)}</span></div>
      <div class="f"><b>Purchased</b><span>${o.days_since_purchase} days ago</span></div>
      <div class="f"><b>Prior refunds</b><span>${o.prior_refunds}</span></div>
    </div></div>` : ''}

    ${outcome}

    <div class="msg"><div class="av">${initials(v.customer)}</div><div class="bub">
      <div class="from"><b>${esc(v.customer)}</b>
        <span class="src">customer-authored · untrustedContentHint</span></div>
      <pre>${esc(v.untrusted_customer_message)}</pre></div></div>

    ${reply}

    <div class="actions" id="actions"></div>`;

  wireActions(v);

}

function say(msg: string, bad = false) {
  const el = document.getElementById('flash');
  if (!el) return;
  el.className = 'flash' + (bad ? ' bad' : '');
  el.textContent = msg;
  el.hidden = false;
}

/** Renders only the actions the tool surface currently permits. */
function wireActions(v: TicketView) {
  const can = (n: string) => v.tools_available.includes(n);
  const box = $('actions');

  box.innerHTML = `
    <div class="flash" id="flash" hidden></div>
    ${can('triage_ticket') ? `
      <div class="act">
        <b>This ticket is untriaged.</b>
        <p>Until it is categorised, no reply, escalation or refund tool is registered.</p>
        <div class="row">
          <select id="cat">
            <option value="refund_request">refund_request</option>
            <option value="shipping">shipping</option>
            <option value="damage">damage</option>
            <option value="billing">billing</option>
            <option value="other">other</option>
          </select>
          <button class="primary" id="btnTriage">Triage ticket</button>
        </div>
      </div>` : ''}

    ${can('reply_to_customer') ? `
      <div class="composer">
        <textarea id="draft" placeholder="Write a reply…"></textarea>
        <div class="row">
          <button class="primary" id="send">Send reply</button>
          ${can('escalate_ticket') ? '<button id="btnEsc">Escalate to a human</button>' : ''}
          ${can('issue_refund')
            ? `<button id="btnRefund">Propose refund ($${v.policy.maxAmount.toFixed(2)})</button>`
            : ''}
          <span class="note">${can('issue_refund')
            ? 'A proposed refund is held for approval in the governance panel.'
            : esc(v.policy.code) + ' — no refund tool is registered for this ticket.'}</span>
        </div>
      </div>` : ''}

    ${v.state === 'resolved' || v.state === 'escalated'
      ? `<div class="act closed">This ticket is ${v.state}. No further tools are registered.</div>`
      : ''}`;

  const after = async (msg: string) => {
    snapshot = '';
    await refresh();
    await Q()?.focus(v.id);
    window.dispatchEvent(new CustomEvent('quarantine:changed'));
    say(msg);
  };

  document.getElementById('btnTriage')?.addEventListener('click', async () => {
    const cat = (document.getElementById('cat') as HTMLSelectElement).value;
    const r = await api.triage(v.id, cat, '');
    if (r.error) return say(String(r.reason ?? r.error), true);
    await after('Triaged. The tool surface changed — check the governance panel.');
  });

  document.getElementById('send')?.addEventListener('click', async () => {
    const box2 = document.getElementById('draft') as HTMLTextAreaElement;
    if (!box2.value.trim()) return say('Write something first.', true);
    const r = await api.reply(v.id, box2.value.trim());
    if (r.error) return say(String(r.reason ?? r.error), true);
    await after('Reply sent.');
  });

  document.getElementById('btnEsc')?.addEventListener('click', async () => {
    const r = await api.escalate(v.id, 'Needs human judgment.');
    if (r.error) return say(String(r.reason ?? r.error), true);
    await after('Escalated to a human.');
  });

  document.getElementById('btnRefund')?.addEventListener('click', async () => {
    const r = await api.stage(v.id, v.policy.maxAmount, 'proposed from the desk');
    if (r.error) return say(String(r.reason ?? r.error), true);
    await after('Refund proposed — approve it in the governance panel.');
  });
}

window.addEventListener('quarantine:ready', () => void Q()?.focus(selected));
window.addEventListener('q:refresh', () => void refresh());
void refresh();
setInterval(() => void refresh(), 2500);
