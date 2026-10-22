import { prisma } from "../../lib/prisma.js";
import type { AgentOutcome } from "./execute.js";

export type ActionLogInput = {
  userId: string;
  sessionId: string;
  messageId?: string;
  outcome: AgentOutcome;
  request: unknown;
  changes?: unknown;
  decisionId?: string;
};

export function logAgentAction(input: ActionLogInput): void {
  prisma.agentActionLog
    .create({
      data: {
        userId: input.userId,
        sessionId: input.sessionId,
        messageId: input.messageId ?? undefined,
        actionKind: input.outcome.action.kind,
        success: input.outcome.action.ok,
        request: JSON.stringify(input.request),
        changes: input.changes !== undefined ? JSON.stringify(input.changes) : undefined,
        decisionId: input.decisionId ?? undefined,
      },
    })
    .catch(() => {});
}
