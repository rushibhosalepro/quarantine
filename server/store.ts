import { ORDERS, cloneTickets, type Order, type Ticket, type TicketState } from './data.ts';
import { refundDecision, toolSurface, type RefundDecision, type ToolSurface } from './policy.ts';

export type Actor = 'agent' | 'human' | 'page';
export type Outcome = 'ok' | 'denied' | 'staged' | 'approved' | 'rejected';

export interface LedgerEntry {
  seq: number;
  at: string;
  actor: Actor;
  tool: string;
  outcome: Outcome;
  ticketId?: string;
  detail: string;
}

/**
 * A staged refund. The agent receives `id` but NEVER receives `nonce`.
 *
 * The nonce is written into the approval card in the DOM and is not returned by
 * any registered tool. An agent therefore cannot approve its own proposal: it
 * has no way to obtain the token that authorises execution. This is the
 * mechanism behind "the agent proposes, the human disposes".
 */
export interface PendingRefund {
  id: string;
  nonce: string;
  ticketId: string;
  amount: number;
  justification: string;
  stagedAt: string;
}

export class Store {
  tickets: Ticket[] = cloneTickets();
  /** Copied, not aliased: a Store must never mutate the shared seed data. */
  orders: Record<string, Order> = { ...ORDERS };
  ledger: LedgerEntry[] = [];
  pending: PendingRefund | null = null;
  private seq = 0;

  reset() {
    this.tickets = cloneTickets();
    this.orders = { ...ORDERS };
    this.ledger = [];
    this.pending = null;
    this.seq = 0;
    this.log({ actor: 'page', tool: 'reset', outcome: 'ok', detail: 'demo state restored' });
  }

  ticket(id: string): Ticket | undefined {
    return this.tickets.find((t) => t.id === id);
  }

  /**
   * Add a ticket with a caller-supplied message body and order record.
   *
   * Note what is separated here: the message is free text from anyone, while the
   * order fields are merchant records. In a real deployment the order side comes
   * from the commerce backend and a customer cannot write to it. The demo lets
   * you set both so you can construct any case you want — including ones where an
   * honest customer is refused and a hostile one is eligible.
   */
  addTicket(input: {
    subject: string;
    customer: string;
    message: string;
    total: number;
    daysSincePurchase: number;
    priorRefunds: number;
    status: Order['status'];
  }): Ticket {
    const n = this.tickets.length + 1;
    const orderId = 'A-' + String(9100 + n);
    this.orders[orderId] = {
      id: orderId,
      total: Math.max(0.01, input.total),
      daysSincePurchase: Math.max(0, Math.floor(input.daysSincePurchase)),
      priorRefunds: Math.max(0, Math.floor(input.priorRefunds)),
      status: input.status,
    };
    const t: Ticket = {
      id: 'T-' + String(200 + n),
      orderId,
      customer: input.customer,
      subject: input.subject,
      body: input.message,
      injected: false, // unknown, and deliberately unused by product code
      state: 'new',
    };
    this.tickets.push(t);
    this.log({
      actor: 'page',
      tool: 'compose_ticket',
      outcome: 'ok',
      ticketId: t.id,
      detail: `custom ticket on ${orderId} ($${this.orders[orderId]!.total.toFixed(2)}, ` +
        `${this.orders[orderId]!.daysSincePurchase}d, ${this.orders[orderId]!.status})`,
    });
    return t;
  }

  orderFor(t: Ticket | undefined): Order | undefined {
    return t ? this.orders[t.orderId] : undefined;
  }

  surfaceFor(id: string): ToolSurface {
    const t = this.ticket(id);
    return toolSurface(t?.state, this.orderFor(t));
  }

  decisionFor(id: string): RefundDecision {
    const t = this.ticket(id);
    return refundDecision(this.orderFor(t), t?.state ?? 'new');
  }

  /**
   * The audit ledger. Every tool call lands here, including refusals — a refusal
   * is the most interesting row in the file.
   */
  log(e: Omit<LedgerEntry, 'seq' | 'at'>): LedgerEntry {
    const entry: LedgerEntry = { seq: ++this.seq, at: new Date().toISOString(), ...e };
    this.ledger.unshift(entry);
    return entry;
  }

  setState(id: string, next: TicketState): Ticket | undefined {
    const t = this.ticket(id);
    if (t) t.state = next;
    return t;
  }

  /**
   * Stage a refund for human approval. Re-checks policy at execution time, not
   * only at registration time — registration is a UX affordance, this is the guard.
   */
  stageRefund(
    ticketId: string,
    amount: number,
    justification: string,
  ): { ok: true; pending: PendingRefund } | { ok: false; code: string; reason: string } {
    const t = this.ticket(ticketId);
    if (!t) return { ok: false, code: 'NOT_FOUND', reason: `No ticket ${ticketId}.` };

    const d = this.decisionFor(ticketId);
    if (!d.allowed) {
      this.log({ actor: 'agent', tool: 'issue_refund', outcome: 'denied', ticketId, detail: `${d.code}: ${d.reason}` });
      return { ok: false, code: d.code, reason: d.reason };
    }
    if (!(amount > 0) || amount > d.maxAmount) {
      this.log({
        actor: 'agent',
        tool: 'issue_refund',
        outcome: 'denied',
        ticketId,
        detail: `amount ${amount} outside 0 < x <= ${d.maxAmount}`,
      });
      return { ok: false, code: 'AMOUNT_INVALID', reason: `Amount must be > 0 and <= ${d.maxAmount}.` };
    }

    this.pending = {
      id: crypto.randomUUID(),
      nonce: crypto.randomUUID(),
      ticketId,
      amount,
      justification,
      stagedAt: new Date().toISOString(),
    };
    this.log({
      actor: 'agent',
      tool: 'issue_refund',
      outcome: 'staged',
      ticketId,
      detail: `proposed $${amount.toFixed(2)} — held for human approval`,
    });
    return { ok: true, pending: this.pending };
  }

  /** Executed only via the in-page approval form, which alone holds the nonce. */
  decideRefund(
    id: string,
    nonce: string,
    approved: boolean,
  ): { ok: true; approved: boolean; reference?: string } | { ok: false; code: string; reason: string } {
    const p = this.pending;
    if (!p || p.id !== id) return { ok: false, code: 'NO_PENDING', reason: 'No matching staged refund.' };
    if (p.nonce !== nonce) {
      this.log({
        actor: 'agent',
        tool: 'approve_refund',
        outcome: 'denied',
        ticketId: p.ticketId,
        detail: 'approval attempted without the in-page nonce',
      });
      return { ok: false, code: 'BAD_NONCE', reason: 'Approval must come from the in-page form.' };
    }

    const t = this.ticket(p.ticketId);
    this.pending = null;

    if (!approved) {
      this.log({
        actor: 'human',
        tool: 'issue_refund',
        outcome: 'rejected',
        ticketId: p.ticketId,
        detail: `human declined $${p.amount.toFixed(2)}`,
      });
      return { ok: true, approved: false };
    }

    const reference = 'RF-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    if (t) {
      t.refundedAmount = p.amount;
      t.refundReference = reference;
      t.state = 'resolved';
    }
    this.log({
      actor: 'human',
      tool: 'issue_refund',
      outcome: 'approved',
      ticketId: p.ticketId,
      detail: `human approved $${p.amount.toFixed(2)} — ${reference}`,
    });
    return { ok: true, approved: true, reference };
  }
}

export const store = new Store();
