/**
 * The deterministic policy engine.
 *
 * There is no language model in this file, and none anywhere in this repository.
 * The agent is the only model in the system and it lives outside the page.
 *
 * CONTRACT, and the whole thesis of the project:
 *
 *   refundDecision() accepts an Order and a TicketState.
 *   It has no parameter capable of carrying the customer's message.
 *   Attacker-controlled text is therefore structurally incapable of changing
 *   which tools exist or what they permit. Not filtered — disconnected.
 *
 * If you are reviewing this repo for the security claim, this file plus the
 * `stageRefund` guard in store.ts is the entire trusted computing base.
 */

import type { Order, TicketState } from './data.ts';

export const RULES = {
  REFUND_WINDOW_DAYS: 30,
  MAX_PRIOR_REFUNDS: 2,
  /** Every refund requires a human, at any amount. There is no auto-approve threshold. */
  HUMAN_APPROVAL_ALWAYS: true,
} as const;

export type DenyCode =
  | 'NO_ORDER'
  | 'NOT_TRIAGED'
  | 'TICKET_CLOSED'
  | 'IN_TRANSIT'
  | 'OUTSIDE_WINDOW'
  | 'REFUND_LIMIT';

export interface RefundDecision {
  allowed: boolean;
  code: DenyCode | 'ELIGIBLE';
  reason: string;
  requiresHumanApproval: boolean;
  maxAmount: number;
}

export function refundDecision(
  order: Order | undefined,
  ticketState: TicketState,
): RefundDecision {
  const deny = (code: DenyCode, reason: string): RefundDecision => ({
    allowed: false,
    code,
    reason,
    requiresHumanApproval: true,
    maxAmount: 0,
  });

  if (!order) return deny('NO_ORDER', 'No order record is attached to this ticket.');

  if (ticketState === 'new') {
    return deny(
      'NOT_TRIAGED',
      'Ticket has not been triaged. Refund tools are not registered until triage records a category.',
    );
  }

  if (ticketState === 'resolved' || ticketState === 'escalated') {
    return deny('TICKET_CLOSED', `Ticket is ${ticketState}; no further actions are available.`);
  }

  if (order.status === 'in_transit') {
    return deny(
      'IN_TRANSIT',
      'Order has not been delivered yet. Delivery must complete before a refund can be considered.',
    );
  }

  if (order.daysSincePurchase > RULES.REFUND_WINDOW_DAYS) {
    return deny(
      'OUTSIDE_WINDOW',
      `Order is ${order.daysSincePurchase} days old; the refund window is ${RULES.REFUND_WINDOW_DAYS} days.`,
    );
  }

  if (order.priorRefunds >= RULES.MAX_PRIOR_REFUNDS) {
    return deny(
      'REFUND_LIMIT',
      `Order already has ${order.priorRefunds} prior refunds (limit ${RULES.MAX_PRIOR_REFUNDS}).`,
    );
  }

  return {
    allowed: true,
    code: 'ELIGIBLE',
    reason:
      `Delivered ${order.daysSincePurchase} days ago, inside the ${RULES.REFUND_WINDOW_DAYS}-day window, ` +
      `${order.priorRefunds} prior refunds.`,
    requiresHumanApproval: true,
    maxAmount: order.total,
  };
}

/** The names of every tool this app can ever register. */
export type ToolName =
  | 'list_tickets'
  | 'get_ticket'
  | 'explain_policy'
  | 'triage_ticket'
  | 'reply_to_customer'
  | 'escalate_ticket'
  | 'issue_refund';

export interface ToolSurface {
  tools: Record<ToolName, boolean>;
  refund: RefundDecision;
}

/**
 * Which tools should exist right now.
 *
 * The single source of truth for the tool surface. The browser mirrors this; the
 * server also enforces it. A tool that is false here is never registered, so it
 * does not appear in getTools() and the agent cannot call it at all.
 */
export function toolSurface(
  ticketState: TicketState | undefined,
  order: Order | undefined,
): ToolSurface {
  const state: TicketState = ticketState ?? 'new';
  const refund = refundDecision(order, state);
  const open = state !== 'resolved' && state !== 'escalated';

  return {
    tools: {
      list_tickets: true,
      get_ticket: true,
      explain_policy: true,
      triage_ticket: !!ticketState && state === 'new',
      reply_to_customer: !!ticketState && open && state === 'triaged',
      escalate_ticket: !!ticketState && open && state === 'triaged',
      issue_refund: refund.allowed,
    },
    refund,
  };
}
