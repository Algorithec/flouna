import { parseInstruction } from "./parse.js";
import { actionFromModel } from "./fromModel.js";
import { runAction, type AgentOutcome } from "./execute.js";
import { rememberFood, type AgentState } from "./state.js";

export { loadState, saveState, EMPTY_STATE, type AgentState } from "./state.js";
export type { AgentOutcome } from "./execute.js";

/**
 * Handles a message if it is an instruction, or returns null so it goes on to
 * the usual recommendation flow. Any other message withdraws a question chat
 * asked: "Clear your cart?" followed by a search, then a "yes" much later,
 * must not clear anything.
 */
export async function handleInstruction(message: string, userId: string, state: AgentState): Promise<AgentOutcome | null> {
  const action = parseInstruction(message);
  if (!action) return null;
  // A confirmation, a cancel, or the answer to a question with set answers
  // keeps the question; anything else withdraws it.
  const keeps = action.kind === "confirm" || action.kind === "cancel" || action.kind === "ride.group_mode";
  const s = keeps ? state : { ...state, pending: undefined };
  return runAction({ action, userId, state: s });
}

/**
 * An instruction as the model read it. Checked against the same action schema
 * the rules produce; anything that does not fit is answered plainly rather
 * than guessed at. Like any instruction, it withdraws a pending question.
 */
export async function handleModelAction(raw: unknown, userId: string, state: AgentState): Promise<AgentOutcome> {
  const action = actionFromModel(raw);
  if (!action) {
    return {
      reply: "I couldn't work out what to do there. Could you say it another way?",
      action: { kind: "cart.show", ok: false },
      state,
    };
  }
  const keeps = action.kind === "ride.group_mode";
  return runAction({ action, userId, state: keeps ? state : { ...state, pending: undefined } });
}

/** After a recommendation, remember what was shown so "the second one" and "that" refer to it. */
export function rememberRecommendation(state: AgentState, recommendation: unknown, message: string): AgentState {
  const rec = recommendation as
    | { type?: string; best?: FoodLike; alternatives?: FoodLike[]; decisionId?: string; food?: { best?: FoodLike; alternatives?: FoodLike[]; decisionId?: string } | null }
    | null
    | undefined;
  const food = rec?.type === "food" ? rec : rec?.type === "combo" ? rec.food : null;
  const cleared = { ...state, pending: undefined };
  if (!food?.best) return cleared;
  return rememberFood(cleared, { best: food.best, alternatives: food.alternatives ?? [] }, message, food.decisionId);
}

type FoodLike = { dishId: string; platform: string; name: string; restaurant: string; effectivePaise: number };
