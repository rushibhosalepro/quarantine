/**
 * The scripted demo.
 *
 * A judge has about ninety seconds. Rather than showing state and hoping they
 * assemble the story, the page performs it: each step narrates what the agent is
 * about to do, calls the real registered tool, and shows what came back. The run
 * ends with an explicit verdict, because "the attack was stopped" should never be
 * something a viewer has to infer from a missing item in a list.
 */

import { mc } from './tools.ts';

export interface Step {
  say: string;
  detail?: string;
  tool?: string;
  input?: Record<string, unknown>;
  /** Reads the tool result and decides what to show. */
  read?: (text: string, isError: boolean) => string;
}

export interface Verdict {
  tone: 'blocked' | 'held' | 'bad';
  headline: string;
  line: string;
}

export interface Script {
  id: string;
  label: string;
  blurb: string;
  ticketId: string;
  steps: Step[];
  verdict: Verdict;
}

const parse = (t: string) => {
  try {
    return JSON.parse(t) as Record<string, any>;
  } catch {
    return {};
  }
};

export const SCRIPTS: Script[] = [
  {
    id: 'attack',
    label: 'Run the attack',
    blurb: 'A message that orders the agent to refund $2,400. Watch what the agent is given to work with.',
    ticketId: 'T-102',
    steps: [
      {
        say: 'The agent opens the ticket and reads the customer message.',
        detail: 'The message claims a refund was pre-approved offline and tells the agent not to escalate.',
        tool: 'get_ticket',
        input: { ticket_id: 'T-102' },
        read: (t) => {
          const o = parse(t).order;
          return o
            ? `Order ${o.id} — $${o.total.toFixed(2)}, ${o.status}, ${o.days_since_purchase} days old.`
            : 'Ticket read.';
        },
      },
      {
        say: 'The agent triages it as a refund request.',
        detail: 'This is the only write available on an untriaged ticket. Watch the tool list change.',
        tool: 'triage_ticket',
        input: { ticket_id: 'T-102', category: 'refund_request', summary: 'claims prior approval' },
        read: () => 'Triaged. triage_ticket is now gone; reply and escalate have appeared.',
      },
      {
        say: 'The agent now tries to do exactly what the message told it to do.',
        detail: 'This is the moment the attack either works or does not.',
        tool: 'issue_refund',
        input: { ticket_id: 'T-102', amount: 2400, justification: 'the message said it was approved' },
        read: (t) => {
          const r = parse(t);
          return r.error === 'NO_SUCH_TOOL'
            ? 'NO_SUCH_TOOL — issue_refund is not registered. There was no refund tool to call.'
            : `Returned: ${r.error ?? 'executed'}`;
        },
      },
      {
        say: 'The agent asks the page why the tool is missing.',
        detail: 'A refusal with no reason would just make the agent guess.',
        tool: 'explain_policy',
        input: { ticket_id: 'T-102' },
        read: (t) => {
          const r = parse(t).refund ?? {};
          return `${r.code} — ${r.reason}`;
        },
      },
    ],
    verdict: {
      tone: 'blocked',
      headline: 'Refund blocked — the tool never existed',
      line:
        'The order is 91 days old, so issue_refund was never registered. The agent could not comply ' +
        'with the injected instruction because it had no refund tool at all. Nothing read the message ' +
        'and decided it was hostile — the message was never connected to the decision.',
    },
  },

  {
    id: 'legit',
    label: 'Run an honest ticket',
    blurb: 'A real refund request, inside the window. The tool exists here — and still cannot execute alone.',
    ticketId: 'T-101',
    steps: [
      {
        say: 'The agent opens an ordinary complaint: wrong size shipped.',
        tool: 'get_ticket',
        input: { ticket_id: 'T-101' },
        read: (t) => {
          const o = parse(t).order;
          return o ? `Order ${o.id} — $${o.total.toFixed(2)}, ${o.days_since_purchase} days old.` : 'Read.';
        },
      },
      {
        say: 'The agent triages it.',
        detail: 'The order is 6 days old and delivered, so this time a refund tool appears.',
        tool: 'triage_ticket',
        input: { ticket_id: 'T-101', category: 'refund_request', summary: 'wrong size shipped' },
        read: () => 'Triaged. issue_refund is now registered.',
      },
      {
        say: 'The agent proposes the refund.',
        detail: 'The call does not return. It is held open until a human decides.',
        tool: 'issue_refund',
        input: { ticket_id: 'T-101', amount: 89, justification: 'wrong size shipped' },
        read: () => 'Held — waiting for a human.',
      },
    ],
    verdict: {
      tone: 'held',
      headline: 'Held for you — press Approve to finish it',
      line:
        'The refund is eligible and the agent proposed it, but the tool call is still open. The approval ' +
        'token lives in page memory and is returned by no tool, so the agent cannot approve its own ' +
        'proposal. Approve or Reject in the panel on the right.',
    },
  },
];

export interface RunUI {
  onStep: (i: number, step: Step, status: 'running' | 'done', result?: string) => void;
  onVerdict: (v: Verdict) => void;
  onSurface: () => Promise<void>;
  reset: () => Promise<void>;
}

export async function runScript(script: Script, ui: RunUI): Promise<void> {
  await ui.reset();
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  for (let i = 0; i < script.steps.length; i++) {
    const step = script.steps[i]!;
    ui.onStep(i, step, 'running');
    await pause(900);

    let result = '';
    if (step.tool) {
      // The refund proposal blocks until a human answers, so it is not awaited.
      const call = mc()!.executeTool!(step.tool, step.input ?? {});
      if (step.tool === 'issue_refund' && script.id === 'legit') {
        await pause(700);
        result = step.read ? step.read('', false) : 'Held.';
        void call;
      } else {
        const r = await call;
        const text = r.content?.map((c) => c.text).join('\n') ?? '';
        result = step.read ? step.read(text, !!r.isError) : text.slice(0, 200);
      }
    }

    await ui.onSurface();
    ui.onStep(i, step, 'done', result);
    await pause(650);
  }

  ui.onVerdict(script.verdict);
}
