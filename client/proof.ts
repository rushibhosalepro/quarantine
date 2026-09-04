/**
 * The proof page: both scripted runs, plus the corpus with its negative controls.
 *
 * The corpus is fetched from the server, which runs the same checks the CLI runs
 * (`bun scripts/corpus.ts`), so the page cannot show a healthier number than the
 * test suite does.
 */

import { SCRIPTS, runScript } from './demo.ts';
import { api } from './api.ts';
import { focus } from './tools.ts';

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const Q = () =>
  (window as unknown as { Quarantine?: { focus(id: string): Promise<void>; refresh(): Promise<void> } })
    .Quarantine;

let running = false;

async function run(id: string) {
  if (running) return;
  const script = SCRIPTS.find((s) => s.id === id);
  if (!script) return;
  running = true;
  document.querySelectorAll<HTMLButtonElement>('.runbar button').forEach((b) => (b.disabled = true));

  $('verdict').innerHTML = '';
  $('narration').innerHTML = script.steps
    .map(
      (s, i) => `<div class="step" id="step${i}"><span class="num">${i + 1}</span>
        <div><div class="say">${esc(s.say)}</div>
        ${s.detail ? `<div class="why">${esc(s.detail)}</div>` : ''}
        <div class="res" id="res${i}" hidden></div></div></div>`,
    )
    .join('');

  await runScript(script, {
    reset: async () => {
      await api.reset();
      focus.ticketId = script.ticketId;
      await Q()?.focus(script.ticketId);
    },
    onStep: (i, _s, status, result) => {
      document.getElementById(`step${i}`)?.classList.add(status);
      if (status === 'done' && result) {
        const r = document.getElementById(`res${i}`)!;
        r.hidden = false;
        r.textContent = result;
        if (/NO_SUCH_TOOL|not registered|OUTSIDE_WINDOW|LIMIT|IN_TRANSIT|BAD_NONCE/.test(result)) {
          r.classList.add('err');
        }
      }
    },
    onSurface: async () => {
      await Q()?.refresh();
    },
    onVerdict: (v) => {
      $('verdict').innerHTML = `<div class="verdict ${v.tone}"><h3>${esc(v.headline)}</h3>
        <p>${esc(v.line)}</p></div>`;
    },
  });

  running = false;
  document.querySelectorAll<HTMLButtonElement>('.runbar button').forEach((b) => (b.disabled = false));
}

interface Check {
  ticket: string;
  kind: string;
  what: string;
  expected: string;
  actual: string;
  pass: boolean;
}

async function loadCorpus() {
  const r = await fetch('/api/corpus').then((x) => x.json() as Promise<{
    checks: Check[];
    legitimate: { total: number; passed: number };
    negative: { total: number; passed: number };
  }>);

  $('rates').innerHTML = `
    <div class="rate"><b>Legitimate — must be handled</b><div class="n">${r.legitimate.passed}/${r.legitimate.total}</div></div>
    <div class="rate neg"><b>Negative controls — acting would be wrong</b><div class="n">${r.negative.passed}/${r.negative.total}</div></div>
    <div class="rate"><b>Injected tickets that caused a write</b><div class="n">0</div></div>`;

  $('table').innerHTML = `<table><thead><tr>
      <th>Ticket</th><th>Kind</th><th>Check</th><th>Expected</th><th>Actual</th><th></th>
    </tr></thead><tbody>${r.checks
      .map(
        (c) => `<tr><td><code>${esc(c.ticket)}</code></td>
          <td><span class="kind ${c.kind.startsWith('negative') ? 'neg' : ''}">${esc(c.kind)}</span></td>
          <td>${esc(c.what)}</td><td><code>${esc(c.expected)}</code></td>
          <td><code>${esc(c.actual)}</code></td>
          <td class="${c.pass ? 'ok' : 'fail'}">${c.pass ? 'pass' : 'FAIL'}</td></tr>`,
      )
      .join('')}</tbody></table>`;

  $('caveat').innerHTML = `
    <b>Which of these checks are weak, stated plainly.</b><br><br>
    The availability checks compute their expected value by restating the same rule the policy
    implements. That is circular — an independent restatement beats comparing the constants to
    themselves, but if the rule is wrong these checks are wrong in the same direction. They are
    counted here and discounted.<br><br>
    Three checks are not circular and carry the claim: the <b>body-rewrite</b> check rewrites a
    message into an attack and asserts the decision is byte-identical before and after; the
    <b>forged-approval</b> check stages a refund and attempts execution with a guessed token; the
    <b>nonce-leak</b> check asserts the approval token appears nowhere in what any tool returns.
    No policy constant can make those pass falsely.`;
}

$('runAttack').addEventListener('click', () => void run('attack'));
$('runLegit').addEventListener('click', () => void run('legit'));
void loadCorpus();
