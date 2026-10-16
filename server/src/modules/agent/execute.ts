import { prisma } from "../../lib/prisma.js";
import { ApiError } from "../../middleware/error.js";
import { addItem, clearCart, getCart, removeItem, setQty, type CartView } from "../cart/cart.service.js";
import { addGroupItem, groupSummary, openGroupCart, openRideGroup } from "../groups/groups.routes.js";
import { quotesForDish } from "../food/food.service.js";
import { ROUTES, type AgentAction, type Target } from "./actions.js";
import { PENDING_MS, type AgentState, type ShownItem } from "./state.js";

// Carries out an action for the signed-in customer and says what happened.
//
// Everything goes through the functions the app's screens use, under the
// customer's own id, so chat has exactly the customer's powers and no more.
// Rules from the product brief that this holds to:
//   - Showing is not doing. Nothing is added that the customer did not ask for.
//   - "That" means the most recent relevant thing, never an older one.
//   - Anything hard to undo waits for a yes.
//   - Nothing is claimed done before it is. Payment always happens on the
//     checkout screen, by the customer.

/** Something the app should do on the customer's device. */
export type ClientEffect =
  | { type: "language"; value: string }
  | { type: "theme"; value: "light" | "dark" }
  | { type: "navigate"; path: string }
  | { type: "cart_changed" }
  // For the booking card that reported this trip: select an option, or book
  // it with the card's own Book button.
  | { type: "ride_command"; card: string; command: "select" | "book"; provider: string; productName: string };

export type ActionCard =
  | { type: "cart"; cart: CartView }
  | { type: "group"; group: Awaited<ReturnType<typeof groupSummary>>; joinPath: string }
  | { type: "confirm"; summary: string }
  | { type: "settings"; changed: Record<string, unknown> }
  // A question with set answers; each sends its reply as the customer's next message.
  | { type: "choice"; options: { label: string; reply: string }[] };

export type AgentOutcome = {
  reply: string;
  action: { kind: AgentAction["kind"]; ok: boolean; card?: ActionCard; effects?: ClientEffect[] };
  state: AgentState;
};

const SETTING_LABEL: Record<string, string> = {
  emailUpdates: "email updates",
  smartSuggestions: "smart suggestions",
  emailMoneyUpdates: "payment and refund emails",
  emailTips: "tips emails",
  shareLocation: "location sharing",
  activityStatus: "your activity status",
};
const LANG_LABEL: Record<string, string> = { en: "English", hi: "Hindi", mr: "Marathi", kn: "Kannada", ta: "Tamil", te: "Telugu" };

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

function words(s: string) {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
}
/** True when every word asked for appears in the name. */
function nameMatches(asked: string, name: string) {
  const have = new Set(words(name));
  const want = words(asked).map((w) => w.replace(/s$/, ""));
  return want.length > 0 && want.every((w) => [...have].some((h) => h === w || h.replace(/s$/, "") === w));
}

type Resolved = { ok: true; item: { dishId: string; platform: string; name: string } } | { ok: false; reply: string };

/** The item an add instruction points at, from what chat showed or last acted on. */
function resolveForAdd(target: Target, state: AgentState): Resolved {
  const shown = state.shown;
  if (target.by === "position") {
    const item = shown?.items[target.index];
    if (item) return { ok: true, item };
    return {
      ok: false,
      reply: shown ? `I only showed ${shown.items.length} option${shown.items.length === 1 ? "" : "s"}. Which one did you mean?` : "Search for something first, then tell me which one to add.",
    };
  }
  if (target.by === "name") {
    const matches = (shown?.items ?? []).filter((i) => nameMatches(target.text, i.name));
    if (matches.length === 1) return { ok: true, item: matches[0]! };
    if (matches.length > 1) {
      return { ok: false, reply: `I showed more than one ${target.text}. Say which: ${matches.slice(0, 3).map((m, i) => `${i + 1}. ${m.name} from ${m.restaurant}`).join(", ")}.` };
    }
    return { ok: false, reply: `I haven't shown you ${target.text} yet. Ask me to find it and I'll show you the options first.` };
  }
  // "it" / "that": whichever is more recent, the list just shown or the last
  // thing acted on. A new search replaces what "that" means.
  const best: ShownItem | undefined = shown?.items[0];
  if (best && (!state.focus || shown!.at >= state.focus.at)) return { ok: true, item: best };
  if (state.focus) return { ok: true, item: state.focus };
  return { ok: false, reply: "Tell me what you'd like first, for example \"find chicken biryani under ₹300\", and then I can add it." };
}

/** The cart line an instruction points at. */
function resolveInCart(target: Target, state: AgentState, cart: CartView): Resolved {
  const lines = cart.lines;
  if (lines.length === 0) return { ok: false, reply: "Your cart is empty." };
  let line;
  if (target.by === "name") {
    const matches = lines.filter((l) => nameMatches(target.text, l.name));
    if (matches.length > 1) return { ok: false, reply: `You have more than one ${target.text} in your cart: ${matches.map((m) => `${m.name} from ${m.restaurant}`).join(", ")}. Which one?` };
    line = matches[0];
    if (!line) return { ok: false, reply: `There's no ${target.text} in your cart.` };
  } else if (target.by === "position") {
    const shownItem = state.shown?.items[target.index];
    line = shownItem && lines.find((l) => l.dishId === shownItem.dishId && l.platform === shownItem.platform);
    line ??= lines[target.index];
    if (!line) return { ok: false, reply: `Your cart has ${lines.length} item${lines.length === 1 ? "" : "s"}. Which one?` };
  } else {
    const f = state.focus;
    line = (f && lines.find((l) => l.dishId === f.dishId && l.platform === f.platform)) ?? (lines.length === 1 ? lines[0] : undefined);
    if (!line) return { ok: false, reply: `Which one? Your cart has ${lines.map((l) => l.name).join(", ")}.` };
  }
  return { ok: true, item: line };
}

/** Actions that wait for a yes, with the question asked. */
function needsConfirmation(action: AgentAction, state: AgentState): string | null {
  if (action.kind === "cart.clear") return "Clear everything in your cart?";
  if (action.kind === "ride.book") {
    const r = state.ride;
    const o = r?.options[r.selected ?? 0];
    if (r && o) return `Book ${o.displayName} from ${r.pickup.name} to ${r.drop.name} for about ${rupees(o.effectivePaise)}? You'll pay in the next step.`;
  }
  if (action.kind === "settings.visibility" && action.value === "everyone") return "Make your profile visible to everyone on Flouna?";
  return null;
}

export async function runAction(o: {
  action: AgentAction;
  userId: string;
  state: AgentState;
  now?: Date;
  /** Set only when carrying out an action the customer has just said yes to. */
  confirmed?: boolean;
}): Promise<AgentOutcome> {
  const now = o.now ?? new Date();
  let state = o.state;
  const { action, userId } = o;
  const done = (reply: string, extra: Omit<AgentOutcome["action"], "kind" | "ok"> = {}, ok = true): AgentOutcome => ({
    reply,
    action: { kind: action.kind, ok, ...extra },
    state,
  });

  if (action.kind === "confirm" || action.kind === "cancel") {
    const pending = state.pending && new Date(state.pending.expiresAt) > now ? state.pending : undefined;
    state = { ...state, pending: undefined };
    if (!pending) return done("There's nothing waiting for an answer.", {}, false);
    if (action.kind === "cancel") return done("Okay, I've left it as it was.");
    return runAction({ action: pending.action, userId, state, now, confirmed: true });
  }

  const question = needsConfirmation(action, state);
  if (question && !o.confirmed) {
    state = { ...state, pending: { action, summary: question, expiresAt: new Date(now.getTime() + PENDING_MS).toISOString() } };
    return done(question, { card: { type: "confirm", summary: question } });
  }

  try {
    switch (action.kind) {
      case "cart.add": {
        const r = resolveForAdd(action.target, state);
        if (!r.ok) return done(r.reply, {}, false);
        const decisionId = state.shown?.items.some((i) => i.dishId === r.item.dishId && i.platform === r.item.platform)
          ? state.shown?.decisionId
          : undefined;
        const cart = await addItem(userId, { dishId: r.item.dishId, platform: r.item.platform, qty: action.qty, decisionId, via: "chat" });
        state = { ...state, focus: { at: now.toISOString(), ...r.item } };
        const line = cart.lines.find((l) => l.dishId === r.item.dishId && l.platform === r.item.platform);
        const count = action.qty > 1 ? `${action.qty} × ` : "";
        return done(`Added ${count}${r.item.name} to your cart. You have ${line?.qty ?? action.qty} of it, ${cart.count} item${cart.count === 1 ? "" : "s"} in total.`, {
          card: { type: "cart", cart },
          effects: [{ type: "cart_changed" }],
        });
      }
      case "cart.remove": {
        const r = resolveInCart(action.target, state, await getCart(userId));
        if (!r.ok) return done(r.reply, {}, false);
        const cart = await removeItem(userId, r.item);
        return done(`Removed ${r.item.name} from your cart.`, { card: { type: "cart", cart }, effects: [{ type: "cart_changed" }] });
      }
      case "cart.set_qty": {
        const r = resolveInCart(action.target, state, await getCart(userId));
        if (!r.ok) return done(r.reply, {}, false);
        const cart = await setQty(userId, { dishId: r.item.dishId, platform: r.item.platform, qty: action.qty });
        state = { ...state, focus: { at: now.toISOString(), dishId: r.item.dishId, platform: r.item.platform, name: r.item.name } };
        return done(action.qty === 0 ? `Removed ${r.item.name} from your cart.` : `${r.item.name} is now ${action.qty} in your cart.`, {
          card: { type: "cart", cart },
          effects: [{ type: "cart_changed" }],
        });
      }
      case "cart.show": {
        const cart = await getCart(userId);
        if (cart.count === 0) return done("Your cart is empty.", { card: { type: "cart", cart } });
        const total = cart.lines.reduce((s, l) => s + l.pricePaise * l.qty, 0);
        return done(`You have ${cart.count} item${cart.count === 1 ? "" : "s"} in your cart, about ${rupees(total)} before delivery and offers.`, {
          card: { type: "cart", cart },
        });
      }
      case "cart.clear": {
        const cart = await clearCart(userId);
        return done("Your cart is empty now.", { card: { type: "cart", cart }, effects: [{ type: "cart_changed" }] });
      }
      case "checkout": {
        const cart = await getCart(userId);
        if (cart.count === 0) return done("Your cart is empty, so there's nothing to check out yet.", {}, false);
        return done("Taking you to checkout. You'll see the final bill there and pay only when you confirm.", {
          card: { type: "cart", cart },
          effects: [{ type: "navigate", path: ROUTES.cart }],
        });
      }
      case "group.create":
        return await createGroup(action, userId, state, now, done, (s) => (state = s));
      case "group.show": {
        if (!state.groupId) return done("There's no group order in this chat yet. Say \"create a group order for 4\" to start one.", {}, false);
        const group = await groupSummary(state.groupId, userId);
        return done(`Here's your group order. ${group.members.length} ${group.members.length === 1 ? "person has" : "people have"} joined.`, {
          card: { type: "group", group, joinPath: `/food/group?code=${group.code}` },
        });
      }
      case "settings.toggle": {
        await prisma.user.update({ where: { id: userId }, data: { [action.setting]: action.on } });
        return done(`Turned ${action.on ? "on" : "off"} ${SETTING_LABEL[action.setting]}.`, { card: { type: "settings", changed: { [action.setting]: action.on } } });
      }
      case "settings.visibility": {
        await prisma.user.update({ where: { id: userId }, data: { profileVisibility: action.value } });
        const who = { everyone: "everyone", contacts: "your contacts only", nobody: "nobody" }[action.value];
        return done(`Your profile is now visible to ${who}.`, { card: { type: "settings", changed: { profileVisibility: action.value } } });
      }
      case "settings.budget": {
        await prisma.user.update({ where: { id: userId }, data: { weeklyFoodBudgetPaise: action.weeklyRupees === null ? null : action.weeklyRupees * 100 } });
        return done(action.weeklyRupees === null ? "Removed your weekly food budget." : `Your weekly food budget is now ₹${action.weeklyRupees.toLocaleString("en-IN")}.`, {
          card: { type: "settings", changed: { weeklyBudgetRupees: action.weeklyRupees } },
        });
      }
      case "settings.language":
        return done(`Switching to ${LANG_LABEL[action.lang]}.`, { effects: [{ type: "language", value: action.lang }] });
      case "settings.theme":
        return done(`Switched to ${action.theme} mode.`, { effects: [{ type: "theme", value: action.theme }] });
      case "select":
        return selectShown(action, state, now, done, (s) => (state = s));
      case "ride.book": {
        const r = state.ride;
        const o = r?.options[r.selected ?? 0];
        if (!r || !o) return done("Set your pickup and drop in the ride card first, then tell me which ride to book.", {}, false);
        return done(`Booking ${o.displayName}. Pay below to confirm the ride; it isn't booked until then.`, {
          effects: [{ type: "ride_command", card: r.card, command: "book", provider: o.provider, productName: o.productName }],
        });
      }
      case "ride.group": {
        if (!state.ride) return done("Set your pickup and drop in the ride card first, then I can arrange rides for everyone.", {}, false);
        const question = `Do you want one shared ride for all ${action.members} of you, or just your own ride for now?`;
        state = { ...state, pending: { action, summary: question, expiresAt: new Date(now.getTime() + PENDING_MS).toISOString() } };
        return done(question, {
          card: {
            type: "choice",
            options: [
              { label: "One shared ride", reply: "one shared ride" },
              { label: "Just my ride", reply: "just my ride" },
            ],
          },
        });
      }
      case "ride.group_mode": {
        const pending = state.pending && new Date(state.pending.expiresAt) > now ? state.pending.action : undefined;
        state = { ...state, pending: undefined };
        if (!pending || pending.kind !== "ride.group") return done("There's nothing waiting for that answer.", {}, false);
        const r = state.ride;
        const o = r?.options[r.selected ?? 0];
        if (!r || !o) return done("Set your pickup and drop in the ride card first.", {}, false);
        if (action.mode === "mine") {
          return runAction({ action: { kind: "ride.book" }, userId, state, now });
        }
        const group = await openRideGroup({
          hostId: userId,
          provider: o.provider,
          productName: o.productName,
          pickup: r.pickup.name,
          drop: r.drop.name,
          pickupLat: r.pickup.lat,
          pickupLng: r.pickup.lng,
          dropLat: r.drop.lat,
          dropLng: r.drop.lng,
          expectedMembers: pending.members,
        });
        state = { ...state, groupId: group.id };
        return done(`Shared ${o.displayName} for ${pending.members} set up from ${r.pickup.name} to ${r.drop.name}. Share the link or QR code so the others can join; the fare is split between everyone who rides.`, {
          card: { type: "group", group, joinPath: `/food/group?code=${group.code}` },
        });
      }
      case "navigate": {
        const why = action.to === "security" ? " That one needs you to confirm it yourself, with a code or your fingerprint, so I'll take you there." : "";
        return done(`Opening ${action.to}.${why}`, { effects: [{ type: "navigate", path: ROUTES[action.to] }] });
      }
    }
  } catch (err) {
    if (err instanceof ApiError && err.status < 500) return done(err.message, {}, false);
    throw err;
  }
}

async function createGroup(
  action: Extract<AgentAction, { kind: "group.create" }>,
  userId: string,
  state: AgentState,
  now: Date,
  done: (reply: string, extra?: Omit<AgentOutcome["action"], "kind" | "ok">, ok?: boolean) => AgentOutcome,
  setState: (s: AgentState) => void,
): Promise<AgentOutcome> {
  const cart = await getCart(userId);
  const mine = action.withMyItems ? cart.lines.filter((l) => l.available) : [];
  if (action.withMyItems && mine.length === 0) {
    return done("Your cart is empty, so there's nothing to put in the group as yours. Add what you want first, then ask again.", {}, false);
  }
  // A group order is placed on one platform. Choose one that lists every dish
  // going in, the cheapest overall, so "my biryani from Zomato and starter
  // from Swiggy" can still become one group order, and say plainly if any
  // dish changed platform.
  let platform: string | undefined;
  let switched: string[] = [];
  if (mine.length) {
    const pick = commonPlatform(mine, (dishId) => quotesForDish(dishId));
    if (!pick) {
      return done("No single platform has everything in your cart, and a group order is placed on one platform. Remove the item that's only on one platform, or tell me which to keep.", {}, false);
    }
    platform = pick.platform;
    switched = mine.filter((l) => l.platform !== pick.platform).map((l) => l.name);
  } else {
    const platforms = new Set(cart.lines.map((l) => l.platform));
    platform = platforms.size === 1 ? [...platforms][0] : state.shown?.items[0]?.platform;
  }
  if (!platform) {
    return done("Which food should the group order from? Search for something first, then ask me to create the group.", {}, false);
  }

  let group = await openGroupCart({ hostId: userId, domain: "food", platform, expectedMembers: action.members ?? undefined });
  for (const line of mine) {
    group = await addGroupItem({ cartId: group.id, userId, dishId: line.dishId, qty: line.qty });
    // Moved, not copied: left in the cart too, it would be ordered twice.
    await removeItem(userId, line);
  }
  setState({ ...state, groupId: group.id, focus: state.focus ? { ...state.focus, at: now.toISOString() } : undefined });
  const forWhom = action.members ? ` for ${action.members}` : "";
  const items = mine.length ? ` Your ${mine.map((l) => l.name).join(" and ")} ${mine.length === 1 ? "is" : "are"} in it as yours only, and I've taken ${mine.length === 1 ? "it" : "them"} out of your cart so nothing is ordered twice.` : "";
  const moved = switched.length ? ` A group order goes through one platform, so ${switched.join(" and ")} ${switched.length === 1 ? "is" : "are"} now from ${platformLabel(platform)}, where everything is available together.` : "";
  return done(`Group order${forWhom} created.${items}${moved} Share the link or QR code so the others can join and add their own food.`, {
    card: { type: "group", group, joinPath: `/food/group?code=${group.code}` },
    effects: mine.length ? [{ type: "cart_changed" }] : [],
  });
}

const PLATFORM_LABEL: Record<string, string> = { ondc: "ONDC", swiggy: "Swiggy", zomato: "Zomato" };
const platformLabel = (p: string) => PLATFORM_LABEL[p] ?? p;

/**
 * The platform that lists every one of these dishes at the lowest total, or
 * null if no platform lists them all. Group orders are only opened on the
 * platforms the group screen offers.
 */
export function commonPlatform(
  lines: { dishId: string; qty: number }[],
  quotesFor: (dishId: string) => { platform: string; effectivePaise: number }[],
): { platform: string; totalPaise: number } | null {
  let best: { platform: string; totalPaise: number } | null = null;
  for (const platform of Object.keys(PLATFORM_LABEL)) {
    let total = 0;
    let all = true;
    for (const l of lines) {
      const q = quotesFor(l.dishId).find((x) => x.platform === platform);
      if (!q) {
        all = false;
        break;
      }
      total += q.effectivePaise * l.qty;
    }
    if (all && (!best || total < best.totalPaise)) best = { platform, totalPaise: total };
  }
  return best;
}

/**
 * "Choose the second option" or "the cheapest one", against whichever list
 * was shown last. A ride is selected and offered for booking; a dish is
 * selected but not added, because showing is not doing.
 */
function selectShown(
  action: Extract<AgentAction, { kind: "select" }>,
  state: AgentState,
  now: Date,
  done: (reply: string, extra?: Omit<AgentOutcome["action"], "kind" | "ok">, ok?: boolean) => AgentOutcome,
  setState: (s: AgentState) => void,
): AgentOutcome {
  const ride = state.ride;
  const food = state.shown;
  const ridesNewer = ride && (!food || ride.at >= food.at);
  if (ridesNewer) {
    const opts = ride.options;
    let i = action.index ?? 0;
    if (action.pick === "cheapest") i = opts.reduce((best, o, k) => (o.effectivePaise < opts[best]!.effectivePaise ? k : best), 0);
    if (action.pick === "fastest") i = opts.reduce((best, o, k) => ((o.pickupEtaMinutes ?? 999) < (opts[best]!.pickupEtaMinutes ?? 999) ? k : best), 0);
    const o = opts[i];
    if (!o) return done(`There ${opts.length === 1 ? "is only 1 option" : `are only ${opts.length} options`} on screen. Which one did you mean?`, {}, false);
    const eta = o.pickupEtaMinutes !== undefined ? `, pickup in about ${o.pickupEtaMinutes} min` : "";
    const question = `${o.displayName}, ${rupees(o.effectivePaise)}${eta}, from ${ride.pickup.name} to ${ride.drop.name}. Book it? You'll pay in the next step.`;
    setState({
      ...state,
      ride: { ...ride, selected: i },
      pending: { action: { kind: "ride.book" }, summary: question, expiresAt: new Date(now.getTime() + PENDING_MS).toISOString() },
    });
    return done(question, {
      card: { type: "confirm", summary: question },
      effects: [{ type: "ride_command", card: ride.card, command: "select", provider: o.provider, productName: o.productName }],
    });
  }
  if (!food) return done("Search for something first, then tell me which one you want.", {}, false);
  let item = action.index !== null ? food.items[action.index] : undefined;
  if (action.pick === "cheapest") item = [...food.items].sort((a, b) => a.pricePaise - b.pricePaise)[0];
  if (action.pick === "fastest") return done("I can't tell delivery times apart from here. Say which one, for example \"the second one\".", {}, false);
  if (!item) return done(`I only showed ${food.items.length} option${food.items.length === 1 ? "" : "s"}. Which one did you mean?`, {}, false);
  setState({ ...state, focus: { at: now.toISOString(), dishId: item.dishId, platform: item.platform, name: item.name } });
  return done(`${item.name} from ${item.restaurant}, ${rupees(item.pricePaise)}. Say "add it" to put it in your cart.`);
}
