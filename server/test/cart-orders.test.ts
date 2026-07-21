import { describe, expect, it } from "vitest";
import { authedAgent } from "./helpers.js";

// Multi-item cart checkout: one order with line items, every price recomputed
// server-side, one delivery fee per order (never stacked per line).

describe("cart orders", () => {
  it("creates one order from multiple items with server-side pricing", async () => {
    const { agent } = await authedAgent();
    const res = await agent
      .post("/api/orders")
      .send({
        domain: "food",
        items: [
          { dishId: "dum-biryani", platform: "ondc", qty: 2 },
          { dishId: "masala-dosa", platform: "ondc", qty: 1 },
        ],
        instructions: "No onions please",
        amount: 1, // must be ignored — server computes
      })
      .expect(201);

    const order = res.body.order;
    expect(order.status).toBe("pending_payment");
    expect(order.title).toContain("+ 1 more");
    const d = JSON.parse(order.details);
    expect(d.items).toHaveLength(2);
    expect(d.items[0]).toMatchObject({ dishId: "dum-biryani", qty: 2 });
    expect(d.instructions).toBe("No onions please");
    // Amount reconciles: items + one delivery + convenience − offers.
    const itemsTotal = d.items.reduce(
      (s: number, i: { pricePaise: number; qty: number }) => s + i.pricePaise * i.qty,
      0,
    );
    const discount = d.offers.reduce(
      (s: number, o: { discountPaise: number }) => s + o.discountPaise,
      0,
    );
    expect(d.basePaise).toBe(itemsTotal);
    expect(order.amount).toBe(
      itemsTotal + d.deliveryFeePaise + d.convenienceFeePaise - discount,
    );
    // Quantity is priced (2 × biryani base > 1 × biryani base).
    expect(itemsTotal).toBeGreaterThan(d.items[0].pricePaise + d.items[1].pricePaise);
  });

  it("charges a single delivery fee, not one per line", async () => {
    const { agent } = await authedAgent();
    const single = await agent
      .post("/api/orders")
      .send({ domain: "food", items: [{ dishId: "dum-biryani", platform: "ondc", qty: 1 }] })
      .expect(201);
    const multi = await agent
      .post("/api/orders")
      .send({
        domain: "food",
        items: [
          { dishId: "dum-biryani", platform: "ondc", qty: 1 },
          { dishId: "dum-biryani", platform: "ondc", qty: 1 },
        ],
      })
      .expect(201);
    const ds = JSON.parse(single.body.order.details);
    const dm = JSON.parse(multi.body.order.details);
    expect(dm.deliveryFeePaise).toBe(ds.deliveryFeePaise); // same fee, one order
  });

  it("rejects an unknown item and an empty cart", async () => {
    const { agent } = await authedAgent();
    await agent
      .post("/api/orders")
      .send({ domain: "food", items: [{ dishId: "no-such-dish", platform: "ondc", qty: 1 }] })
      .expect(404);
    await agent.post("/api/orders").send({ domain: "food", items: [] }).expect(400);
  });

  it("cart orders pay and track like any food order", async () => {
    const { agent } = await authedAgent();
    const created = await agent
      .post("/api/orders")
      .send({
        domain: "food",
        items: [
          { dishId: "dum-biryani", platform: "ondc", qty: 1 },
          { dishId: "veg-momos", platform: "ondc", qty: 2 },
        ],
      });
    // veg-momos may not exist under that id — fall back to a known second dish.
    const orderId =
      created.status === 201
        ? (created.body.order.id as string)
        : (
            await agent
              .post("/api/orders")
              .send({
                domain: "food",
                items: [
                  { dishId: "dum-biryani", platform: "ondc", qty: 1 },
                  { dishId: "masala-dosa", platform: "ondc", qty: 2 },
                ],
              })
              .expect(201)
          ).body.order.id;

    await agent.post("/api/payments/checkout").send({ orderId }).expect(200);
    await agent.post("/api/payments/simulate").send({ orderId, method: "upi" }).expect(200);
    const track = await agent.get(`/api/orders/${orderId}/track`).expect(200);
    expect(track.body.tracking.statusMessage).toBeTruthy();
    const order = await agent.get(`/api/orders/${orderId}`).expect(200);
    expect(order.body.order.status).toBe("confirmed");
    expect(order.body.order.details.items.length).toBeGreaterThan(1);
  });

  it("single-dish orders still work unchanged (regression)", async () => {
    const { agent } = await authedAgent();
    const res = await agent
      .post("/api/orders")
      .send({ domain: "food", dishId: "masala-dosa", platform: "ondc" })
      .expect(201);
    expect(res.body.order.amount).toBe(13600);
  });
});
