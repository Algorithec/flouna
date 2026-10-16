import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { actionSchema } from "./actions.js";

// What chat remembers between messages, per conversation.
//
// Explicit and small, rather than the model re-reading the transcript, so
// "add that too" resolves to exactly one item and the same message always
// does the same thing. Stored on the chat session.

const shownItem = z.object({
  dishId: z.string(),
  platform: z.string(),
  name: z.string(),
  restaurant: z.string(),
  pricePaise: z.number().int(),
});
export type ShownItem = z.infer<typeof shownItem>;

export const stateSchema = z.object({
  v: z.literal(1),
  /** The last list chat showed, in the order it was shown. */
  shown: z
    .object({ at: z.string(), query: z.string(), decisionId: z.string().optional(), items: z.array(shownItem).max(20) })
    .optional(),
  /** The last item an instruction acted on, for "add another". */
  focus: z.object({ at: z.string(), dishId: z.string(), platform: z.string(), name: z.string() }).optional(),
  /** The group order made in this conversation, for "add it to the group". */
  groupId: z.string().optional(),
  /** An action waiting for the customer's yes. */
  pending: z.object({ action: actionSchema, summary: z.string(), expiresAt: z.string() }).optional(),
});
export type AgentState = z.infer<typeof stateSchema>;

export const EMPTY_STATE: AgentState = { v: 1 };

/** How long a question like "Clear your cart?" stays answerable. */
export const PENDING_MS = 5 * 60_000;

export async function loadState(sessionId: string): Promise<AgentState> {
  const row = await prisma.chatSession.findUnique({ where: { id: sessionId }, select: { agentState: true } });
  if (!row?.agentState) return EMPTY_STATE;
  try {
    const parsed = stateSchema.safeParse(JSON.parse(row.agentState));
    // State written by an older shape is dropped, not half read.
    return parsed.success ? parsed.data : EMPTY_STATE;
  } catch {
    return EMPTY_STATE;
  }
}

export async function saveState(sessionId: string, state: AgentState): Promise<void> {
  await prisma.chatSession.update({ where: { id: sessionId }, data: { agentState: JSON.stringify(state) } });
}

/**
 * Remembers a food recommendation as the list "the second one" refers to: the
 * best pick first, then the alternatives, as the chat card shows them.
 */
export function rememberFood(
  state: AgentState,
  rec: { best: ShownItemSource; alternatives: ShownItemSource[] },
  query: string,
  decisionId: string | undefined,
  now = new Date(),
): AgentState {
  const items = [rec.best, ...rec.alternatives].slice(0, 20).map((q) => ({
    dishId: q.dishId,
    platform: q.platform,
    name: q.name,
    restaurant: q.restaurant,
    pricePaise: q.effectivePaise,
  }));
  return { ...state, shown: { at: now.toISOString(), query: query.slice(0, 80), ...(decisionId ? { decisionId } : {}), items } };
}

type ShownItemSource = { dishId: string; platform: string; name: string; restaurant: string; effectivePaise: number };
