import { env } from "../../../config/env.js";
import { parseIntent, type Intent, type LlmProvider } from "./types.js";
import { SYSTEM_PROMPT, JSON_SHAPE } from "./prompt.js";

const CONDENSED_PROMPT = `You are Flouna's intent classifier. Output ONLY valid JSON matching this schema:
{"domain":"food|ride|shop|combo|action|greeting|out_of_scope","reply":"string","food":{"item":"string","budgetPaise":null|int,"maxEtaMinutes":null|int,"dietary":"any|veg|vegan|jain|halal|egg","priority":"balanced|cheap|fast|healthy"},"ride":{"from":"string","to":"string","passengers":int,"vehicle":"auto|bike|mini|sedan|suv|any","scheduleAt":null|"ISO8601"},"shop":{"item":"string","budgetPaise":null|int,"priority":"balanced|cheap|fast|rated"},"action":{"kind":"cart.add|cart.remove|cart.set_qty|cart.show|cart.clear|checkout|group.create|group.show|select|ride.book|ride.group|ride.group_mode|settings.toggle|settings.visibility|settings.budget|settings.language|settings.theme|navigate","targetBy":"position|name|none","targetPosition":int,"targetName":"string","qty":int,"members":int,"withMyItems":bool,"pick":"cheapest|fastest|closest|none","setting":"string","on":bool,"value":"string","weeklyRupees":int,"destination":"string"}}
Include only the domain's sub-object. Omit null optional fields or set them null.`;

export class OllamaProvider implements LlmProvider {
  name = "ollama";

  async extractIntent(userMessage: string): Promise<Intent> {
    const base = (env.OLLAMA_URL ?? "http://localhost:11434").replace(/\/+$/, "");
    const model = env.OLLAMA_MODEL ?? "flouna";

    const systemContent = model.includes("v3")
      ? CONDENSED_PROMPT
      : `${SYSTEM_PROMPT}\n\n${JSON_SHAPE}`;

    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(env.LLM_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        ...(env.OLLAMA_API_KEY ? { Authorization: `Bearer ${env.OLLAMA_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model,
        response_format: { type: "json_object" },
        max_tokens: 512,
        temperature: 0,
        messages: [
          { role: "system", content: systemContent },
          { role: "user", content: userMessage },
        ],
      }),
    });
    if (!res.ok) {
      throw new Error(`Ollama request failed (${res.status})`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("Ollama returned no content");
    const raw = JSON.parse(content) as Record<string, unknown>;

    // Small models often fill the parts they did not use with null ("food":
    // null beside a real ride). The schema rejects a null part, so one such
    // answer failed whole and chat fell back to another provider, and a key
    // that is present but empty would also have counted towards the domain.
    // An empty part is the same as an absent one.
    for (const part of ["food", "ride", "shop", "action"]) {
      if (raw[part] === null) delete raw[part];
    }

    if (typeof raw.domain === "string") {
      raw.domain = raw.domain.replace(/\s+/g, "_").toLowerCase();
    }

    const priorityMap: Record<string, string> = {
      none: "balanced", cheap: "price", cheapest: "price",
      fast: "speed", fastest: "speed", quick: "speed", quickest: "speed",
      rated: "rating", "highest rated": "rating", "top rated": "rating",
      healthy: "healthy",
    };
    for (const key of ["food", "ride", "shop"]) {
      const sub = raw[key] as Record<string, unknown> | undefined;
      if (!sub) continue;
      const p = String(sub.priority ?? "").toLowerCase();
      if (priorityMap[p]) sub.priority = priorityMap[p];

      if (key === "food") {
        const d = String((sub as Record<string, unknown>).dietary ?? "").toLowerCase();
        if (d === "non-veg" || d === "non_veg" || d === "nonvegetarian" || d === "non-vegetarian")
          (sub as Record<string, unknown>).dietary = "nonveg";
      }
    }

    // The 0.5B model reliably outputs the right sub-objects but sometimes
    // omits the domain field. Infer it from whichever keys are present.
    if (!raw.domain) {
      const hasFood = "food" in raw && raw.food != null;
      const hasRide = "ride" in raw && raw.ride != null;
      const hasShop = "shop" in raw && raw.shop != null;
      if (hasFood && hasRide) raw.domain = "combo";
      else if (hasFood) raw.domain = "food";
      else if (hasRide) raw.domain = "ride";
      else if (hasShop) raw.domain = "shop";
      else if (raw.reply) raw.domain = "greeting";
      else raw.domain = "out_of_scope";
    }
    if (!raw.reply) raw.reply = "";

    // The fine-tuned model sometimes hallucates a partial action object on
    // non-action domains. Strip it so parseIntent does not reject the whole
    // response over missing required action fields.
    if (raw.domain !== "action" && "action" in raw) delete raw.action;

    // v3 condensed-prompt model sometimes outputs flat fields instead of nested
    // sub-objects (e.g. {"domain":"food","item":"pizza"} instead of
    // {"domain":"food","food":{"item":"pizza"}}). Wrap them.
    if (raw.domain === "food" && !raw.food && raw.item) {
      raw.food = {
        item: raw.item,
        budgetPaise: raw.budgetPaise ?? null,
        maxEtaMinutes: raw.maxEtaMinutes ?? null,
        dietary: raw.dietary ?? "any",
        priority: raw.priority ?? "balanced",
      };
      delete raw.item; delete raw.budgetPaise; delete raw.maxEtaMinutes;
      delete raw.dietary; delete raw.priority;
    }
    if (raw.domain === "ride" && !raw.ride && (raw.from || raw.to || raw.pickup || raw.drop)) {
      raw.ride = {
        from: raw.from ?? raw.pickup ?? "",
        to: raw.to ?? raw.drop ?? "",
        passengers: raw.passengers ?? 1,
        vehicle: raw.vehicle ?? "any",
        scheduleAt: raw.scheduleAt ?? null,
      };
      delete raw.from; delete raw.to; delete raw.pickup; delete raw.drop;
      delete raw.passengers; delete raw.vehicle; delete raw.scheduleAt;
    }
    if ((raw.domain === "shop" || raw.domain === "shopping") && !raw.shop && raw.item) {
      raw.domain = "shop";
      raw.shop = {
        item: raw.item,
        budgetPaise: raw.budgetPaise ?? null,
        priority: raw.priority ?? "balanced",
      };
      delete raw.item; delete raw.budgetPaise; delete raw.priority;
      delete raw.subcategory; delete raw.category;
    }

    // Normalize non-standard domain names
    if (raw.domain === "shopping") raw.domain = "shop";

    return parseIntent(raw);
  }
}
