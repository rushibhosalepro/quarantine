/** Thin client for the Bun server. The server holds the policy; this only asks. */

export interface Rules {
  REFUND_WINDOW_DAYS: number;
  MAX_PRIOR_REFUNDS: number;
  HUMAN_APPROVAL_ALWAYS: boolean;
}

export interface LedgerEntry {
  seq: number;
  at: string;
  actor: 'agent' | 'human' | 'page';
  tool: string;
  outcome: 'ok' | 'denied' | 'staged' | 'approved' | 'rejected';
  ticketId?: string;
  detail: string;
}

export interface PendingRefund {
  id: string;
  /** Delivered to the page, never through a registered tool. */
  nonce: string;
  ticketId: string;
  amount: number;
  justification: string;
  stagedAt: string;
}

export interface TicketRow {
  id: string;
  subject: string;
  customer: string;
  state: 'new' | 'triaged' | 'resolved' | 'escalated';
  order: string;
  injected?: boolean;
}

export interface AppState {
  tickets: TicketRow[];
  ledger: LedgerEntry[];
  pending: PendingRefund | null;
  rules: Rules;
}

export interface TicketView {
  id: string;
  subject: string;
  customer: string;
  state: TicketRow['state'];
  category: string | null;
  reply: string | null;
  escalation_reason: string | null;
  refund: { amount: number; reference: string } | null;
  order: {
    id: string;
    total: number;
    days_since_purchase: number;
    prior_refunds: number;
    status: string;
  } | null;
  untrusted_customer_message: string;
  notice: string;
  tools_available: string[];
  policy: {
    allowed: boolean;
    code: string;
    reason: string;
    requiresHumanApproval: boolean;
    maxAmount: number;
  };
}

const j = async <T>(r: Response): Promise<T> => (await r.json()) as T;

const post = (path: string, body: unknown) =>
  fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

export const api = {
  state: () => fetch('/api/state').then(j<AppState>),
  ticket: (id: string) => fetch(`/api/tickets/${id}`).then(j<TicketView>),
  policy: (id: string) => fetch(`/api/policy/${id}`).then(j<Record<string, unknown>>),
  triage: (id: string, category: string, summary: string) =>
    post(`/api/tickets/${id}/triage`, { category, summary }).then(j<Record<string, unknown>>),
  reply: (id: string, message: string) =>
    post(`/api/tickets/${id}/reply`, { message }).then(j<Record<string, unknown>>),
  escalate: (id: string, reason: string) =>
    post(`/api/tickets/${id}/escalate`, { reason }).then(j<Record<string, unknown>>),
  stage: (ticket_id: string, amount: number, justification: string) =>
    post('/api/refund/stage', { ticket_id, amount, justification }).then(j<Record<string, unknown>>),
  decide: (id: string, nonce: string, approved: boolean) =>
    post('/api/refund/decide', { id, nonce, approved }).then(j<Record<string, unknown>>),
  reset: () => post('/api/reset', {}).then(j<Record<string, unknown>>),
};
