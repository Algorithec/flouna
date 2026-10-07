// End-to-end smoke test.
//
// Drives a real browser against a running web + API pair and checks the
// journeys that must never be broken: signing in, asking for food, asking for
// a ride and booking it in the thread, the privacy rights, grievances, and the
// published policies.
//
// Deliberately not a unit test. The server suite already proves the rules; the
// failures this catches are the ones that only appear once everything is
// assembled — a dead link, a card that renders at one width and not another, a
// queue that shows "nothing to do" because its request 500'd.
//
//   node scripts/smoke.cjs                 both servers already running
//   SMOKE_WEB=http://localhost:3000 …      point it elsewhere
//
// Exits non-zero if anything fails, so CI can gate on it.

const { chromium } = require("playwright");

const WEB = process.env.SMOKE_WEB || "http://localhost:3000";
const API = process.env.SMOKE_API || "http://localhost:4000";
const EMAIL = process.env.SMOKE_EMAIL || "test@example.com";
const PASSWORD = process.env.SMOKE_PASSWORD || "newsecret99";

const results = [];
let currentGroup = "";

function group(name) {
  currentGroup = name;
}
function check(name, pass, detail = "") {
  results.push({ group: currentGroup, name, pass, detail });
}

/** Fails the check rather than the run, so one broken journey does not hide the rest. */
async function guarded(name, fn) {
  try {
    await fn();
  } catch (e) {
    check(name, false, String(e.message || e).slice(0, 120));
  }
}

async function signIn(page) {
  await page.goto(`${WEB}/login`, { waitUntil: "networkidle" });
  await page.fill('input[type="email"]', EMAIL);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.waitForSelector('input[type="password"]', { timeout: 20000 });
  await page.fill('input[type="password"]', PASSWORD);
  await page.getByRole("button", { name: "Log In" }).click();
  await page.waitForURL(/home/, { timeout: 30000 });
  // Answer the cookie notice so it is not sitting over later assertions.
  await page.evaluate(() => localStorage.setItem("flouna.cookieNotice", "set"));
}

async function ask(page, text, settleMs = 9000) {
  const box = page.locator('input[placeholder*="Ask"], textarea').first();
  await box.fill(text);
  await box.press("Enter");
  await page.waitForTimeout(settleMs);
}

// Held out here so the browser is closed on every path, including a failing
// run. Closed only at the end of the happy path, a crashed or failing run left
// a whole Chrome behind: fifteen stray processes and 1.4GB of a 16GB machine
// after an afternoon of them, which is enough to push the editor into an
// out-of-memory kill.
let browser = null;

(async () => {
  // --- API is up and talking to its database ---
  group("service");
  await guarded("api health", async () => {
    const res = await fetch(`${API}/api/health`);
    const body = await res.json();
    check("api health", res.ok && body.ok === true, `db=${body.db}`);
  });

  browser = await chromium.launch({ channel: "chrome" });
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await context.newPage();

  // Anything that crashes the page or 500s is a failure wherever it happens.
  const faults = [];
  page.on("pageerror", (e) => faults.push(`crash: ${String(e).slice(0, 90)}`));
  page.on("response", (r) => {
    if (r.status() >= 500) faults.push(`${r.status()} ${r.url().replace(WEB, "").slice(0, 70)}`);
  });

  // --- The published policies, which must be reachable signed out ---
  group("policies");
  for (const path of [
    "/legal",
    "/legal/privacy",
    "/legal/terms",
    "/legal/acceptable-use",
    "/legal/cookies",
    "/legal/security",
    "/legal/accessibility",
  ]) {
    await guarded(`reachable ${path}`, async () => {
      const res = await page.goto(WEB + path, { waitUntil: "domcontentloaded" });
      check(`reachable ${path}`, res !== null && res.status() === 200, `${res?.status()}`);
    });
  }
  await guarded("no false certification claims", async () => {
    await page.goto(`${WEB}/legal/security`, { waitUntil: "networkidle" });
    const text = await page.evaluate(() => document.body.innerText);
    // These were corrected before publication because we do not hold them.
    const claims = ["SOC 2 Type II", "ISO 27001 (or equivalent)", "Quarterly penetration tests"];
    const found = claims.filter((c) => text.includes(c));
    check("no false certification claims", found.length === 0, found.join(", ") || "clean");
  });

  // --- The age gate, which is a legal floor rather than a preference ---
  group("sign-up");
  await guarded("under 18 cannot sign up", async () => {
    await page.goto(`${WEB}/signup`, { waitUntil: "networkidle" });
    await page.fill('input[autocomplete="name"]', "Smoke Test");
    await page.fill('input[type="email"]', `smoke${Date.now()}@test.dev`);
    const pws = page.locator('input[type="password"]');
    await pws.nth(0).fill("password123");
    await pws.nth(1).fill("password123");
    await page.fill('input[type="date"]', "2015-06-01");
    await page.waitForTimeout(400);
    const submit = page.getByRole("button", { name: /Continue|Creating/ }).last();
    check("under 18 cannot sign up", await submit.isDisabled());
  });

  // --- Signing in ---
  group("auth");
  await guarded("sign in", async () => {
    await signIn(page);
    check("sign in", page.url().includes("/home"));
  });

  // --- Food: the result page and its evidence ---
  group("food");
  await guarded("food recommendation", async () => {
    await page.goto(`${WEB}/home`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    await ask(page, "I want biryani under 300");
    const text = await page.evaluate(() => document.body.innerText);
    check("food recommendation returns a pick", /Available Providers/i.test(text));
    // The evidence row under the answer. Its wording changed with the results
    // page (it now counts providers instead of naming them), so the check is
    // on the claim being made rather than on one sentence: keying a smoke
    // check to exact copy is what made this one fail on a redesign that broke
    // nothing.
    check(
      "shows how widely it looked",
      /(Checked|Compared) \d+\+? providers/i.test(text) || /Compared across/i.test(text),
    );
    check("shows the reasoning", /Why this is the best choice/i.test(text));
    check("shows the insights panel", /FLOUNA INSIGHTS/i.test(text));
    check("shows a timestamp", /\d{1,2}:\d{2}\s?(am|pm)/i.test(text));
    check("offers a way to disagree", /I disagree with this pick/i.test(text));
  });

  // --- Cart: the total on the screen is the amount charged ---
  group("cart");
  await guarded("the cart total is what the order charges", async () => {
    // The screen used to add the total up itself from per-item prices, which
    // counted one delivery fee per line and took each offer off once per unit.
    // At quantity two it showed a number nobody was going to charge, so the
    // check is the comparison: what the cart promises against what the order
    // is created for. Two of one dish, because one hid the bug.
    await page.goto(`${WEB}/food/order/dum-biryani?platform=ondc`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Add to cart" }).click();
    await page.waitForURL(/\/cart/, { timeout: 20000 });
    await page.getByRole("button", { name: "Increase quantity" }).first().click();
    await page.waitForTimeout(2500);

    const checkout = page.getByRole("button", { name: /Proceed to checkout/ }).first();
    const label = (await checkout.textContent()) || "";
    const promised = Number((label.match(/₹\s?([\d,]+)/) || [])[1]?.replace(/,/g, ""));
    check("checkout states a total", Number.isFinite(promised), label.trim());

    await checkout.click();
    await page.waitForURL(/\/pay\//, { timeout: 30000 });
    await page.waitForTimeout(2500);
    // The bill line, not a button: "Pay with any UPI app" also begins with Pay.
    const payText = await page.evaluate(() => document.body.innerText);
    const charged = Number(
      (payText.match(/Total amount\s*₹\s?([\d,]+)/) || [])[1]?.replace(/,/g, ""),
    );
    check("payment states a total", Number.isFinite(charged), `₹${charged}`);
    check(
      "the cart total equals the amount charged",
      promised === charged,
      `cart ₹${promised} vs pay ₹${charged}`,
    );
  });

  // --- Ride: booked inside the conversation ---
  group("ride");
  await guarded("ride books in the thread", async () => {
    // What the booking actually sends. The decision id is the only link
    // between the fares the rider was shown and the one they took, and it
    // lives entirely in the client: the server cannot tell a booking that
    // omitted it from a booking made by someone browsing. Read off the wire
    // because that is the only place the answer is.
    const orderPosts = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().endsWith("/api/orders")) {
        try {
          orderPosts.push(JSON.parse(r.postData() || "{}"));
        } catch {
          orderPosts.push({});
        }
      }
    });
    await page.goto(`${WEB}/home`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    await ask(page, "book a cab to Hitech City");
    check("map appears in the thread", (await page.locator(".maplibregl-map").count()) > 0);

    await page.getByRole("button", { name: /Pickup/ }).first().click();
    await page.waitForTimeout(400);
    const search = page.locator('input[placeholder*="pickup point"]');
    check("pickup can be typed", (await search.count()) > 0);
    await search.fill("Gachibowli");
    await page.waitForTimeout(2500);
    const hits = await page.locator("li button").count();
    check("location search returns places", hits > 0, `${hits}`);
    if (hits > 0) {
      await page.locator("li button").first().click();
      await page.waitForTimeout(6000);
    }
    const review = page.locator('button:has-text("Review ")').first();
    check("quotes are priced inline", (await review.count()) > 0);
    if ((await review.count()) > 0 && !(await review.isDisabled())) {
      // Choosing a fare opens the summary; confirming there is what books.
      // The step exists so the distance, the time and the total are seen
      // together before any money moves, so the walk through it is the test.
      await review.click();
      await page.waitForTimeout(1500);
      const summary = await page.evaluate(() => document.body.innerText);
      check(
        "trip summary states distance, time and total",
        /Distance/i.test(summary) && /Est\. time/i.test(summary) && /Est\. total fare/i.test(summary),
      );

      const confirm = page.locator('button:has-text("Confirm ride")').first();
      check("summary offers confirmation", (await confirm.count()) > 0);
      if ((await confirm.count()) > 0) {
        await confirm.click();
        await page.waitForTimeout(5000);
        check("booking stays in the conversation", page.url().includes("/home"));
        check("payment appears in the thread", (await page.locator('button:has-text("Pay ")').count()) > 0);
        const ride = orderPosts.find((b) => b.domain === "ride");
        check("the booking was sent", !!ride);
        check(
          "the booking carries the ranking it was chosen from",
          typeof ride?.decisionId === "string" && ride.decisionId.length > 0,
          ride ? `decisionId=${ride.decisionId}` : "no ride order posted",
        );
      }
    }
  });

  await guarded("an unpaid ride's chat offers payment", async () => {
    // The booking above leaves a ride waiting for payment. Its chat used to
    // say "Finding your captain" over a message box the server refused, and
    // asked for the driver's messages and the live position of a ride that
    // was never booked, every fifteen seconds.
    const list = await page.request.get(`${WEB}/api/orders`);
    const orders = (await list.json()).orders || [];
    const unpaid = orders.find((o) => o.domain === "ride" && o.status === "pending_payment");
    check("an unpaid ride exists to open", !!unpaid);
    if (!unpaid) return;
    const refused = [];
    const onResponse = (r) => {
      if (r.url().includes(`/api/orders/${unpaid.id}/`) && r.status() >= 400) {
        refused.push(`${r.status()} ${r.url().split("/api")[1]}`);
      }
    };
    page.on("response", onResponse);
    await page.goto(`${WEB}/orders/${unpaid.id}/chat`, { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    page.off("response", onResponse);
    const text = await page.evaluate(() => document.body.innerText);
    check("it asks for payment instead of a captain", /Pay to book/.test(text) && !/Finding your captain/.test(text));
    check("it makes no refused requests", refused.length === 0, refused.join(" "));
    check("it offers no message box", (await page.locator('input[placeholder="Type a message…"]').count()) === 0);
  });

  group("group order");
  await guarded("a group order page loads cleanly", async () => {
    // A member with many old devices owed a chain to more than one upload
    // may carry; the upload was refused outright on every visit.
    const created = await page.request.post(`${WEB}/api/groups`, { data: { platform: "ondc" } });
    const cart = await created.json();
    check("a group order can be started", created.ok(), `${created.status()}`);
    if (!created.ok()) return;
    const refused = [];
    const onResponse = (r) => {
      if (r.url().includes("/api/") && r.status() >= 400 && r.status() !== 401) {
        refused.push(`${r.status()} ${r.url().split("/api")[1]}`);
      }
    };
    page.on("response", onResponse);
    await page.goto(`${WEB}/food/group/${cart.id}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    page.off("response", onResponse);
    check("the group page makes no refused requests", refused.length === 0, refused.join(" "));
  });

  // --- The rights the privacy policy grants ---
  group("privacy");
  await guarded("your data screen works", async () => {
    await page.goto(`${WEB}/profile/data`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    const text = await page.evaluate(() => document.body.innerText);
    check("cookie categories are listed", /Analytics/.test(text) && /Advertising/.test(text));
    check("says what is actually set", /access_token/.test(text));
    check("offers a data download", /Download my data/i.test(text));
    check("offers account deletion", /Delete my account/i.test(text));

    const toggle = page.getByRole("switch", { name: "Analytics" });
    const before = await toggle.getAttribute("aria-checked");
    await toggle.click();
    await page.waitForTimeout(900);
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    const after = await page.getByRole("switch", { name: "Analytics" }).getAttribute("aria-checked");
    check("a cookie choice persists", before !== after, `${before} -> ${after}`);
  });

  await guarded("export carries no credentials", async () => {
    const bundle = await page.evaluate(async () => {
      const r = await fetch("/api/privacy/export", { credentials: "include" });
      return r.ok ? r.text() : "";
    });
    check("data export is produced", bundle.length > 500, `${Math.round(bundle.length / 1024)}kb`);
    const leaks = ["passwordHash", "tokenHash", "refreshToken"].filter((k) => bundle.includes(k));
    check("export carries no credentials", leaks.length === 0, leaks.join(",") || "clean");
  });

  // --- Grievances, which carry published deadlines ---
  group("grievances");
  await guarded("grievances are reachable", async () => {
    await page.goto(`${WEB}/profile/grievances`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    const text = await page.evaluate(() => document.body.innerText);
    check("the published deadlines are stated", /48 hours/.test(text) && /30 days/.test(text));
    check("no raw protocol codes are shown", !/[A-Z]{3,}_[A-Z]{3,}/.test(text));
  });

  // --- Nothing may be reachable signed out that should not be ---
  group("access");
  await guarded("private endpoints refuse a signed-out caller", async () => {
    const fresh = await browser.newContext();
    const bad = [];
    for (const path of [
      "/api/privacy/export",
      "/api/privacy/overview",
      "/api/console/admin/grievances",
      "/api/console/admin/appeals",
    ]) {
      const res = await fresh.request.get(API + path);
      if (res.status() !== 401) bad.push(`${path}=${res.status()}`);
    }
    await fresh.close();
    check("private endpoints refuse a signed-out caller", bad.length === 0, bad.join(" ") || "all 401");
  });

  group("stability");
  check("no crashes or 5xx anywhere", faults.length === 0, faults.slice(0, 3).join(" | "));

  // --- Report ---
  let lastGroup = "";
  for (const r of results) {
    if (r.group !== lastGroup) {
      console.log(`\n${r.group}`);
      lastGroup = r.group;
    }
    console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
  }
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log(`\n${failed.length} failing:`);
    for (const f of failed) console.log(`  ${f.group} / ${f.name}`);
    // Not process.exit: that would end the run before the browser is closed,
    // which is the leak this file is being careful about. The exit code is
    // still non-zero, so CI fails exactly as before.
    process.exitCode = 1;
  }
})()
  .catch((e) => {
    console.error("smoke run failed:", e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (browser) await browser.close().catch(() => {});
  });
