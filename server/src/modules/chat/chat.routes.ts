import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireAuth } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { ApiError } from "../../middleware/error.js";
import { checkMessage, FIREWALL_REPLIES } from "./firewall.js";
import { llm, demoFallback } from "./llm/index.js";
import { FallbackProvider } from "./llm/fallback.js";
import type { Intent } from "./llm/types.js";
import {
  recommendFood,
  searchFoodTraced,
  withoutTrace,
  type FoodQuote,
} from "../food/food.service.js";
import type { NearestMiss } from "../advisor/constraints.js";
import { quoteRidesTraced, unmetRideNote } from "../rides/rides.service.js";
import { withCommunityRatings, allCommunityRatings } from "../ratings/ratings.service.js";
import { recommendProduct } from "../shop/shop.service.js";
import { adviseFood, adviseRide } from "../advisor/advisor.service.js";
import { recordObservation } from "../advisor/priceHistory.service.js";
import { recordDecision } from "../advisor/decisionLog.service.js";
import { weeklyFoodBudget } from "../users/budget.service.js";
import {
  buildDecisionProfile,
  personalizationFrom,
} from "../advisor/decisionProfile.service.js";
import type { Priority } from "../advisor/scoring.js";
import { buildContext } from "../advisor/context.service.js";
import { istStartOfDay, istTimeLabel } from "../../lib/istTime.js";
import { watchIntent } from "./llm/watcher.js";
import { readWithConfidence } from "./llm/demo.js";
import { env } from "../../config/env.js";
import { ondcSearchFor, startOndcSearch } from "../ondc/search.service.js";
import { EMPTY_STATE, handleInstruction, handleModelAction, loadState, rememberRecommendation, saveState } from "../agent/index.js";
import { logAgentAction } from "../agent/audit.js";
import { rideContextSchema, type RideContext } from "../agent/state.js";

// Paise → "₹123" for chat copy.
const rupees = (paise: number) => `₹${Math.round(paise / 100)}`;

/**
 * What to say when a limit the customer set ruled out every option.
 *
 * The reply used to be "I couldn't find biryani near you", which was true when
 * nothing matched. Now that a stated price is enforced, an empty result can
 * mean biryani exists and none of it is under ₹300, and telling that customer
 * there is no biryani would be false. So the limit is named, and the nearest
 * option is offered as information. It is not recommended: offering it as the
 * pick would undo the limit the customer set.
 */
function unmetFoodReply(item: string, unmet: NearestMiss<FoodQuote>): string {
  const q = unmet.item;
  if (unmet.rule === "max_price") {
    return `Nothing for "${item}" comes in under ${rupees(q.effectivePaise - unmet.by)} right now. The closest is ${rupees(q.effectivePaise)} for ${q.name} at ${q.restaurant}.`;
  }
  return `Nothing for "${item}" arrives within ${q.etaMinutes - unmet.by} minutes right now. The quickest is ${q.etaMinutes} minutes, ${q.name} at ${q.restaurant}.`;
}

export const chatRouter = Router();
chatRouter.use(requireAuth);

// Layer 4 of the firewall: per-user chat budget.
const chatLimit = rateLimit({
  windowMs: 60_000,
  limit: process.env.NODE_ENV === "test" ? 1000 : 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => req.userId ?? req.ip ?? "anon",
  message: { error: "You're sending messages too fast, give me a few seconds." },
});

type AssistantPayload = {
  reply: string;
  intent: Intent;
  recommendation?: unknown;
  /** Which model produced the intent, for the training corpus. */
  served?: { provider: string; depth: number };
};

// A short budget line shown under a food pick — only when a budget is set.
function budgetNoteFor(
  budget: Awaited<ReturnType<typeof weeklyFoodBudget>>,
  pickPaise: number,
): string | null {
  if (budget.remainingPaise == null) return null;
  const afterPaise = budget.remainingPaise - pickPaise;
  if (afterPaise < 0) {
    return `Heads up, this is ${rupees(-afterPaise)} over your weekly food budget.`;
  }
  return `${rupees(afterPaise)} left in your weekly food budget after this.`;
}

// A model does not always return the vehicle even when the rider names it —
// "book a cab to the airport" came back with the drop but no vehicle, so every
// type was quoted and a bike was recommended for an airport run. If the person
// said which one they wanted, that settles it, whichever provider is running.
function vehicleFrom(
  message: string,
  extracted: "bike" | "auto" | "cab" | "any" | undefined,
): "bike" | "auto" | "cab" | "any" | undefined {
  if (extracted && extracted !== "any") return extracted;
  if (/\b(bike|scooter|two[- ]?wheeler)\b/i.test(message)) return "bike";
  if (/\b(auto|rickshaw|tuk[- ]?tuk)\b/i.test(message)) return "auto";
  if (/\b(cab|taxi|car|sedan)\b/i.test(message)) return "cab";
  return extracted;
}

// Personalization only kicks in when the user didn't state a preference
// ("balanced") — an explicit "cheapest"/"top-rated" always wins as asked. Builds
// the spend-band + taste signals from the user's own profile; returns undefined
// for new users so thin data never skews their picks.
async function personalForBalanced(
  userId: string,
  priority: Priority | undefined,
) {
  if (priority && priority !== "balanced") return undefined;
  const profile = await buildDecisionProfile(userId);
  return personalizationFrom(profile, (item) => item.name ?? "");
}

// A one-line note telling the user the pick was adapted to them (only shown when
// personalization actually had data to apply).
function personalizedNote(
  personal: Awaited<ReturnType<typeof personalForBalanced>>,
): string | null {
  if (!personal) return null;
  if (personal.spendBand === "budget")
    return "Tuned to your habits, you tend to keep it value-friendly, so I leaned cheaper.";
  if (personal.spendBand === "premium")
    return "Tuned to your habits, you usually go for quality, so I leaned higher-rated.";
  if (personal.tasteBonus)
    return "Picked with your usual favourites in mind.";
  return null;
}

async function buildAssistantPayload(
  message: string,
  userId: string,
): Promise<AssistantPayload> {
  let intent: Intent;
  // Recorded per message: with a provider chain the corpus is a mix of vendors,
  // and training on it later is only possible if each row says who wrote it.
  let served: { provider: string; depth: number };
  // Hybrid routing: a reading the rules are sure of is answered at once, and
  // labelled as theirs. Only a doubtful one waits seconds for a model.
  const byRules = env.HYBRID_ROUTING && llm.name !== "demo" ? readWithConfidence(message) : null;
  try {
    if (byRules?.confident) {
      intent = byRules.intent;
      served = { provider: "demo", depth: 0 };
    } else if (llm instanceof FallbackProvider) {
      const traced = await llm.extractIntentTraced(message);
      intent = traced.intent;
      served = traced.served;
    } else {
      intent = await llm.extractIntent(message);
      served = { provider: llm.name, depth: 0 };
    }
  } catch (err) {
    // Every provider failed — degrade to rule-based mode rather than dropping
    // chat, and label the row so it is never mistaken for model output.
    console.error(`[chat] all providers failed, using demo fallback:`, err);
    intent = await demoFallback.extractIntent(message);
    served = { provider: "demo", depth: -1 };
  }

  // The watcher reads the same message beside the answer and is measured
  // against it. Not awaited: the customer's reply never waits for it, and
  // nothing it returns reaches them.
  void watchIntent(message, intent, served.provider);

  // An instruction the rules did not recognise, read by the model. Carried
  // out by the caller, which holds the conversation's memory.
  if (intent.domain === "action") return { reply: intent.reply, intent, served };

  // Faculty 3: the situation this decision is made in (time + weather). Built
  // once and layered onto food/ride advice. Never blocks — degrades offline.
  const ctx = await buildContext();

  // "at 10pm" → the next time it is ten at night in India (today, else
  // tomorrow), as an ISO timestamp the rides screen books with. Somebody
  // typing a time means their own; on a UTC host this booked the cab for
  // half past three in the morning.
  const resolveScheduleAt = (hhmm: string | null | undefined): string | null => {
    if (!hhmm) return null;
    const [h, m] = hhmm.split(":").map(Number);
    let t = new Date(
      istStartOfDay(ctx.now).getTime() + h! * 3_600_000 + m! * 60_000,
    );
    if (t.getTime() <= ctx.now.getTime())
      t = new Date(t.getTime() + 24 * 3_600_000);
    return t.toISOString();
  };
  const scheduleLabel = (iso: string) =>
    istTimeLabel(new Date(iso));

  if (intent.domain === "combo" && intent.food && intent.ride) {
    const comboBudget = await weeklyFoodBudget(userId);
    const comboWeekly =
      comboBudget.remainingPaise && comboBudget.remainingPaise > 0
        ? comboBudget.remainingPaise
        : null;
    // The same rules as a food request on its own. Anything else would make
    // "biryani under ₹300" enforce the price while "biryani under ₹300 and a
    // cab home" quietly showed food above it.
    const comboStated = intent.food.budgetPaise ?? null;
    const comboFoodOpts = {
      query: `${intent.food.item} ${message}`,
      budgetPaise: comboStated === null ? comboWeekly : null,
      dietary: intent.food.dietary,
      constraints: {
        maxPricePaise: comboStated,
        maxEtaMinutes: intent.food.maxEtaMinutes ?? null,
      },
    };
    const foodRec = recommendFood({
      ...comboFoodOpts,
      priority: intent.food.priority,
      community: await allCommunityRatings("food"),
    });
    const foodUnmet = foodRec ? null : searchFoodTraced(comboFoodOpts).unmet;
    const {
      quotes: baseRideQuotes,
      trace: comboRideTrace,
      unmet: comboRideUnmet,
    } = quoteRidesTraced({
      distanceKm: 8,
      rideMinutes: 24,
      vehicle: vehicleFrom(message, intent.ride.vehicle),
      priority: intent.ride.priority,
      // Pickup only, for the reason given on the ride path below: the fare is
      // for a placeholder trip and cannot honestly be held to a stated limit.
      constraints: { maxPickupMinutes: intent.ride.maxPickupMinutes ?? null },
    });
    const rideQuotes = await withCommunityRatings("ride", baseRideQuotes, (q) => q.provider);
    if (foodRec) recordObservation("food", foodRec.best.dishId, foodRec.best.effectivePaise);
    if (rideQuotes[0]) recordObservation("ride", rideQuotes[0].vehicle, rideQuotes[0].effectivePaise);
    // A combo is two rankings in one message; both are logged so neither half
    // of the decision is unexplainable after the fact.
    const comboFoodDecisionId = foodRec
      ? recordDecision({ userId, domain: "food", query: message, trace: foodRec.trace })
      : null;
    const comboRideDecisionId = comboRideTrace
      ? recordDecision({ userId, domain: "ride", query: message, trace: comboRideTrace })
      : null;
    const comboScheduledAt = resolveScheduleAt(intent.ride.scheduleAt);
    return {
      reply: intent.reply,
      intent,
      served,
      recommendation: {
        type: "combo",
        food: foodRec
          ? {
              ...withoutTrace(foodRec),
              ...(comboFoodDecisionId ? { decisionId: comboFoodDecisionId } : {}),
              advice: await adviseFood(foodRec.best.dishId, ctx.now, ctx),
            }
          : null,
        // Why the food half is empty, when the reason is the customer's own
        // limit rather than an unmatched dish.
        ...(foodUnmet ? { foodNote: unmetFoodReply(intent.food.item, foodUnmet) } : {}),
        ride: {
          ...(comboRideDecisionId ? { decisionId: comboRideDecisionId } : {}),
          drop: intent.ride.drop,
          pickup: intent.ride.pickup,
          quotes: rideQuotes.slice(0, 3),
          scheduledAt: comboScheduledAt,
          // With no ride left, naming "the cheapest" would print "undefined".
          why:
            rideQuotes.length === 0
              ? comboRideUnmet
                ? unmetRideNote(comboRideUnmet)
                : `No rides are available for that trip right now.`
              : comboScheduledAt
                ? `Cheapest fare is ${rideQuotes[0]!.displayName}, scheduled for ${scheduleLabel(comboScheduledAt)}, open Rides to confirm.`
                : `Cheapest fare is ${rideQuotes[0]!.displayName}, open Rides to set exact pickup.`,
          advice: await adviseRide(rideQuotes[0]?.vehicle ?? null, ctx.now, ctx),
        },
      },
    };
  }

  if (intent.domain === "food" && intent.food) {
    // Budget Guardian awareness: if the user didn't name a budget but has a
    // weekly food budget set, cap suggestions at what's left this week.
    const budget = await weeklyFoodBudget(userId);
    const weeklyCap =
      budget.remainingPaise != null && budget.remainingPaise > 0
        ? budget.remainingPaise
        : null;
    // Two ceilings with opposite rules. A price the customer named is a limit
    // and is enforced. The weekly allowance is advice, applies only when they
    // named no price of their own, and is still waived rather than leave
    // nothing to show. They used to share one parameter, which is why a stated
    // price could be quietly exceeded.
    const stated = intent.food.budgetPaise ?? null;
    const searchOpts = {
      // Some models genericize the extracted item ("popular dishes") and drop
      // the user's actual craving words. Append the raw message so descriptors
      // like "spicy" / "healthy" always reach the search (filler words are
      // stripped there); the LLM's item still leads for real dish names.
      query: `${intent.food.item} ${message}`,
      budgetPaise: stated === null ? weeklyCap : null,
      dietary: intent.food.dietary,
      constraints: {
        maxPricePaise: stated,
        maxEtaMinutes: intent.food.maxEtaMinutes ?? null,
      },
    };

    // ONDC sellers are searched alongside, without waiting: their stores
    // answer over the next seconds and the app shows them as they arrive.
    const ondc = (await ondcSearchFor(userId).catch(() => false))
      ? await startOndcSearch(userId, intent.food.item, { wait: false }).catch(() => null)
      : null;

    const personal = await personalForBalanced(userId, intent.food.priority);
    const rec = recommendFood({
      ...searchOpts,
      priority: intent.food.priority,
      personal,
      community: await allCommunityRatings("food"),
    });
    if (rec) {
      recordObservation("food", rec.best.dishId, rec.best.effectivePaise);
      // Kept, not discarded. The pairing that closes the learning loop needs
      // this id to come back with the order, and chat is where almost every
      // order starts, so throwing it away here left the loop recording
      // nothing at all.
      const decisionId = recordDecision({
        userId,
        domain: "food",
        query: message,
        trace: rec.trace,
      });
      // If the best in-budget pick still exceeds what's left, the engine returns
      // the cheapest option anyway — we surface that honestly via the note
      // rather than hiding it or refusing.
      const budgetNote = budgetNoteFor(budget, rec.best.effectivePaise);
      const personalNote = personalizedNote(personal);
      return {
        reply: intent.reply,
        intent,
        served,
        recommendation: {
          type: "food",
          ...withoutTrace(rec),
          decisionId,
          ...(ondc ? { ondc } : {}),
          advice: await adviseFood(rec.best.dishId, ctx.now, ctx),
          ...(budgetNote ? { budgetNote } : {}),
          ...(personalNote ? { personalNote } : {}),
        },
      };
    }
    // Empty because a stated limit ruled everything out, rather than because
    // nothing matched. Those need different answers, and only one of them is
    // "there is no biryani".
    const { unmet } = searchFoodTraced(searchOpts);
    if (unmet) {
      return { reply: unmetFoodReply(intent.food.item, unmet), intent, served };
    }
    return {
      reply: `I couldn't find "${intent.food.item}" near you right now, try biryani, pizza, dosa, or a thali?`,
      intent,
      served,
    };
  }

  if (intent.domain === "ride" && intent.ride) {
    // Without live geocoding in chat we quote a typical city trip;
    // exact fares come from the rides screen once locations are picked.
    const { quotes: baseQuotes, trace: rideTrace, unmet } = quoteRidesTraced({
      distanceKm: 8,
      rideMinutes: 24,
      vehicle: vehicleFrom(message, intent.ride.vehicle),
      priority: intent.ride.priority,
      // Only the pickup wait is enforced here. That is a property of each
      // provider and does not depend on the trip.
      //
      // A stated fare is deliberately not, because chat prices every ride as a
      // placeholder 8 km trip. Enforced against that, "cab to the airport under
      // ₹300" would pass at a fake fare and cost twice as much on the real
      // route, and a one kilometre ride that fits would be refused. Either is
      // a broken promise of exactly the kind a stated limit exists to prevent,
      // so the fare limit travels with the recommendation and is checked where
      // the real route is known.
      constraints: { maxPickupMinutes: intent.ride.maxPickupMinutes ?? null },
    });
    if (baseQuotes.length === 0 && unmet) {
      return {
        reply: unmetRideNote(unmet),
        intent,
        served,
      };
    }
    const quotes = await withCommunityRatings("ride", baseQuotes, (q) => q.provider);
    if (quotes[0]) recordObservation("ride", quotes[0].vehicle, quotes[0].effectivePaise);
    const rideDecisionId = rideTrace
      ? recordDecision({ userId, domain: "ride", query: message, trace: rideTrace })
      : null;
    // Send the full spread so the chat's Bike/Cab/Auto switcher always has
    // every available vehicle type (we only cap when a specific type was asked).
    // Resolved, not raw: the model regularly omits a vehicle the rider named,
    // and vehicleFrom is what catches "book a bike ride". Reading the raw field
    // here let the cap disagree with the filter the quotes were built under.
    const askedVehicle = vehicleFrom(message, intent.ride.vehicle);
    const sent =
      askedVehicle && askedVehicle !== "any" ? quotes.slice(0, 5) : quotes;
    const scheduledAt = resolveScheduleAt(intent.ride.scheduleAt);
    return {
      reply: intent.reply,
      intent,
      served,
      recommendation: {
        type: "ride",
        ...(rideDecisionId ? { decisionId: rideDecisionId } : {}),
        drop: intent.ride.drop,
        pickup: intent.ride.pickup,
        // What the rider actually asked for. Without this the booking card in
        // the chat opens on "any" and re-prices every vehicle type, so asking
        // for a bike returns cab fares alongside it.
        vehicle: askedVehicle ?? "any",
        quotes: sent,
        scheduledAt,
        // The fare the rider named, carried with the recommendation. Nothing
        // enforces it yet: the booking card does not send it to the rides
        // route, which is the one place the real route is priced. Until it
        // does, the reply below asks the rider to compare rather than claiming
        // a check that does not happen.
        ...(intent.ride.budgetPaise ? { fareLimitPaise: intent.ride.budgetPaise } : {}),
        // Carried for the same reason as the fare: the booking card re-prices
        // the real trip, and a limit left behind here is a limit the rider
        // stated and nothing applied.
        ...(intent.ride.maxPickupMinutes
          ? { pickupLimitMinutes: intent.ride.maxPickupMinutes }
          : {}),
        why: intent.ride.budgetPaise
          ? `You asked for under ${rupees(intent.ride.budgetPaise)}. These fares are for a typical 8 km trip, so set your pickup and drop below to see the exact fare before you book.`
          : scheduledAt
          ? `Cheapest effective fare is ${quotes[0]?.displayName} after offers, scheduled for ${scheduleLabel(scheduledAt)}, open Rides to confirm.`
          : // Chat has no pickup coordinates, so these fares price a typical
            // 8 km city trip. Saying so keeps a short hop and an airport run
            // from both being quoted at the same number without explanation.
            `Cheapest effective fare is ${quotes[0]?.displayName} after offers, for a typical 8 km trip. Set your pickup and drop below to see the exact price.`,
        advice: await adviseRide(quotes[0]?.vehicle ?? null, ctx.now, ctx),
      },
    };
  }

  if (intent.domain === "shop" && intent.shop) {
    const personal = await personalForBalanced(userId, intent.shop.priority);
    const rec = recommendProduct({
      query: intent.shop.item,
      budgetPaise: intent.shop.budgetPaise,
      category: intent.shop.category === "any" ? null : intent.shop.category,
      priority: intent.shop.priority,
      personal,
    });
    if (rec) {
      const personalNote = personalizedNote(personal);
      return {
        reply: intent.reply,
        intent,
        served,
        recommendation: {
          type: "shop",
          ...rec,
          ...(personalNote ? { personalNote } : {}),
        },
      };
    }
    return {
      reply: `I couldn't find "${intent.shop.item}" right now, try a laptop, earbuds, shoes, or a smartwatch?`,
      intent,
      served,
    };
  }

  return { reply: intent.reply, intent };
}

chatRouter.post(
  "/message",
  chatLimit,
  validateBody(
    z.object({
      message: z.string().max(2000),
      sessionId: z.string().cuid().optional(),
      // Temporary chat: answer normally but persist nothing — no session, no
      // messages. It never appears in Recent Chats and never feeds the
      // personalisation that reads chat history.
      temporary: z.boolean().optional(),
    }).strict(),
  ),
  async (req, res, next) => {
    try {
      const { message, sessionId, temporary } = req.body as {
        message: string;
        sessionId?: string;
        temporary?: boolean;
      };

      const verdict = checkMessage(message);

      // ---- temporary chat: compute the answer, write nothing to the DB ----
      if (temporary) {
        // Instructions still work, with no memory: nothing is kept between
        // temporary messages, so "add that" has nothing to point at.
        const done = verdict.ok ? await handleInstruction(message.trim(), req.userId!, EMPTY_STATE) : null;
        if (done) {
          return res.json({
            sessionId: null,
            temporary: true,
            message: { id: `tmp-${Date.now()}`, role: "assistant", content: done.reply, domain: "action", action: done.action, recommendation: null },
          });
        }
        const payload: AssistantPayload = verdict.ok
          ? await buildAssistantPayload(message.trim(), req.userId!)
          : {
              reply: FIREWALL_REPLIES[verdict.reason],
              intent: { domain: "out_of_scope", reply: FIREWALL_REPLIES[verdict.reason] },
            };
        if (payload.intent.domain === "action") {
          const acted = await handleModelAction(payload.intent.action, req.userId!, EMPTY_STATE);
          return res.json({
            sessionId: null,
            temporary: true,
            message: { id: `tmp-${Date.now()}`, role: "assistant", content: acted.reply, domain: "action", action: acted.action, recommendation: null },
          });
        }
        return res.json({
          sessionId: null,
          temporary: true,
          message: {
            id: `tmp-${Date.now()}`,
            role: "assistant",
            content: payload.reply,
            domain: payload.intent.domain,
            recommendation: payload.recommendation ?? null,
          },
        });
      }

      let session =
        sessionId &&
        (await prisma.chatSession.findFirst({
          where: { id: sessionId, userId: req.userId! },
        }));
      if (sessionId && !session) throw new ApiError(404, "Chat not found");
      // Writing in an archived chat makes it current again.
      if (session && session.archivedAt) {
        session = await prisma.chatSession.update({ where: { id: session.id }, data: { archivedAt: null } });
      }
      if (!session) {
        session = await prisma.chatSession.create({
          data: {
            userId: req.userId!,
            title: message.trim().slice(0, 60),
          },
        });
      }

      await prisma.chatMessage.create({
        data: { sessionId: session.id, role: "user", content: message.trim().slice(0, 500) },
      });

      // An instruction ("add that too", "create a group order for 4") is
      // carried out against what this conversation remembers.
      const memoryReadAt = new Date().toISOString();
      const memory = await loadState(session.id);
      const done = verdict.ok ? await handleInstruction(message.trim(), req.userId!, memory) : null;
      if (done) {
        await saveState(session.id, done.state, { readAt: memoryReadAt });
        const saved = await prisma.chatMessage.create({
          data: {
            sessionId: session.id,
            role: "assistant",
            content: done.reply,
            intent: JSON.stringify({ domain: "action", action: done.action }),
            provider: "agent",
          },
        });
        logAgentAction({ userId: req.userId!, sessionId: session.id, messageId: saved.id, outcome: done, request: done.action });
        return res.json({
          sessionId: session.id,
          message: {
            id: saved.id,
            role: "assistant",
            content: done.reply,
            at: saved.createdAt.toISOString(),
            domain: "action",
            action: done.action,
            recommendation: null,
          },
        });
      }

      const payload: AssistantPayload = verdict.ok
        ? await buildAssistantPayload(message.trim(), req.userId!)
        : {
            reply: FIREWALL_REPLIES[verdict.reason],
            intent: { domain: "out_of_scope", reply: FIREWALL_REPLIES[verdict.reason] },
          };

      if (payload.intent.domain === "action") {
        const acted = await handleModelAction(payload.intent.action, req.userId!, memory);
        await saveState(session.id, acted.state, { readAt: memoryReadAt });
        const saved = await prisma.chatMessage.create({
          data: {
            sessionId: session.id,
            role: "assistant",
            content: acted.reply,
            // `reading` is training data (trainingExport.ts) and never leaves the server.
            intent: JSON.stringify({ domain: "action", action: acted.action, reading: payload.intent }),
            provider: payload.served?.provider ?? null,
            providerDepth: payload.served?.depth ?? null,
          },
        });
        logAgentAction({ userId: req.userId!, sessionId: session.id, messageId: saved.id, outcome: acted, request: payload.intent.action });
        return res.json({
          sessionId: session.id,
          message: { id: saved.id, role: "assistant", content: acted.reply, at: saved.createdAt.toISOString(), domain: "action", action: acted.action, recommendation: null },
        });
      }

      // What was shown becomes what "that" and "the second one" refer to.
      await saveState(session.id, rememberRecommendation(memory, payload.recommendation, message.trim()), { readAt: memoryReadAt });

      const assistantMessage = await prisma.chatMessage.create({
        data: {
          sessionId: session.id,
          role: "assistant",
          content: payload.reply,
          intent: JSON.stringify({
            domain: payload.intent.domain,
            recommendation: payload.recommendation ?? null,
            // What the model read the message as, kept as training data for our
            // own engine (trainingExport.ts). Never sent back to the browser.
            reading: payload.intent,
          }),
          provider: payload.served?.provider ?? null,
          providerDepth: payload.served?.depth ?? null,
        },
      });

      res.json({
        sessionId: session.id,
        message: {
          id: assistantMessage.id,
          role: "assistant",
          content: payload.reply,
          at: assistantMessage.createdAt.toISOString(),
          domain: payload.intent.domain,
          recommendation: payload.recommendation ?? null,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// The booking card in a conversation reports the trip it priced and its
// options in the order shown, so "choose the second option" means the second
// one on screen. Only used to tell which option was meant: booking re-prices
// the trip on the server and refuses a fare that has moved.
chatRouter.post(
  "/sessions/:id/ride",
  validateBody(rideContextSchema.omit({ at: true }).strict()),
  async (req, res, next) => {
    try {
      const session = await prisma.chatSession.findFirst({ where: { id: req.params.id, userId: req.userId! }, select: { id: true } });
      if (!session) throw new ApiError(404, "Chat not found");
      const memory = await loadState(session.id);
      const ride = { ...(req.body as Omit<RideContext, "at">), at: new Date().toISOString() };
      // A new trip or a re-priced list keeps the customer's tap on an option
      // only if the card said which.
      await saveState(session.id, { ...memory, ride });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

const SESSION_SUMMARY = { id: true, title: true, updatedAt: true, pinnedAt: true, archivedAt: true } as const;

// Recent chats: pinned ones first (most recently pinned on top), then the
// latest twenty. ?archived=1 lists the archived ones instead.
chatRouter.get("/sessions", async (req, res, next) => {
  try {
    const userId = req.userId!;
    const toSummary = (s: { id: string; title: string | null; updatedAt: Date; pinnedAt: Date | null; archivedAt: Date | null }) => ({
      id: s.id,
      title: s.title,
      updatedAt: s.updatedAt,
      pinned: s.pinnedAt !== null,
      archived: s.archivedAt !== null,
    });
    if (req.query.archived === "1") {
      const archived = await prisma.chatSession.findMany({
        where: { userId, archivedAt: { not: null } },
        orderBy: { archivedAt: "desc" },
        take: 50,
        select: SESSION_SUMMARY,
      });
      return res.json({ sessions: archived.map(toSummary) });
    }
    const [pinned, rest, archivedCount] = await Promise.all([
      prisma.chatSession.findMany({
        where: { userId, archivedAt: null, pinnedAt: { not: null } },
        orderBy: { pinnedAt: "desc" },
        take: 50,
        select: SESSION_SUMMARY,
      }),
      prisma.chatSession.findMany({
        where: { userId, archivedAt: null, pinnedAt: null },
        orderBy: { updatedAt: "desc" },
        take: 20,
        select: SESSION_SUMMARY,
      }),
      prisma.chatSession.count({ where: { userId, archivedAt: { not: null } } }),
    ]);
    res.json({ sessions: [...pinned, ...rest].map(toSummary), archivedCount });
  } catch (err) {
    next(err);
  }
});

// Rename, pin or archive one of your own chats. Archiving also unpins, so an
// unarchived chat comes back in its place among the recent ones.
chatRouter.patch(
  "/sessions/:id",
  validateBody(
    z
      .object({
        title: z.string().trim().min(1).max(80).optional(),
        pinned: z.boolean().optional(),
        archived: z.boolean().optional(),
      })
      .strict()
      .refine((b) => Object.keys(b).length > 0, "Nothing to change"),
  ),
  async (req, res, next) => {
    try {
      const body = req.body as { title?: string; pinned?: boolean; archived?: boolean };
      const now = new Date();
      const data: { title?: string; pinnedAt?: Date | null; archivedAt?: Date | null } = {};
      if (body.title !== undefined) data.title = body.title;
      if (body.pinned !== undefined) data.pinnedAt = body.pinned ? now : null;
      if (body.archived !== undefined) {
        data.archivedAt = body.archived ? now : null;
        if (body.archived) data.pinnedAt = null;
      }
      // updateMany with the owner in the filter: someone else's chat id
      // behaves exactly like one that does not exist.
      const done = await prisma.chatSession.updateMany({ where: { id: req.params.id!, userId: req.userId! }, data });
      if (done.count === 0) throw new ApiError(404, "Chat not found");
      const session = await prisma.chatSession.findUniqueOrThrow({ where: { id: req.params.id! }, select: SESSION_SUMMARY });
      res.json({
        session: { id: session.id, title: session.title, pinned: session.pinnedAt !== null, archived: session.archivedAt !== null },
      });
    } catch (err) {
      next(err);
    }
  },
);

// Deletes one of your own chats and every message in it, for good.
chatRouter.delete("/sessions/:id", async (req, res, next) => {
  try {
    const done = await prisma.chatSession.deleteMany({ where: { id: req.params.id!, userId: req.userId! } });
    if (done.count === 0) throw new ApiError(404, "Chat not found");
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/** A stored message's JSON as the browser may see it: without the model's reading. */
function shownPart(intent: string): Record<string, unknown> {
  try {
    const { reading: _reading, ...shown } = JSON.parse(intent) as Record<string, unknown>;
    return shown;
  } catch {
    return {};
  }
}

chatRouter.get("/sessions/:id", async (req, res, next) => {
  try {
    const session = await prisma.chatSession.findFirst({
      where: { id: req.params.id, userId: req.userId! },
      include: {
        // The newest hundred, then put back in reading order. Taking the first
        // hundred ascending is what a cap looks like from the wrong end: open a
        // conversation with any real history and it restored the opening
        // exchange and nothing since, with the reply you were reading a moment
        // ago missing entirely.
        messages: { orderBy: { createdAt: "desc" }, take: 100 },
      },
    });
    if (!session) throw new ApiError(404, "Chat not found");
    res.json({
      session: {
        id: session.id,
        title: session.title,
        messages: [...session.messages].reverse().map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          // When it was sent. Without this a restored conversation loses every
          // timestamp, and so does the live one the moment the URL gains a
          // ?chat= and the client swaps its local list for this response.
          at: m.createdAt.toISOString(),
          ...(m.intent ? shownPart(m.intent) : {}),
        })),
      },
    });
  } catch (err) {
    next(err);
  }
});
