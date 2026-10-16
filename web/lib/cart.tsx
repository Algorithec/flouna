"use client";

// The cart, as the app sees it. It lives on the server (/api/cart) so the app
// and chat act on one cart: "add it to my cart" in chat and the Add button on
// a dish card change the same thing. Only ids and quantities are sent; names
// and prices come back from the server's catalogue, and checkout reprices
// everything regardless.
//
// Changes show at once and are then replaced by the server's answer, which is
// the whole cart as it now stands. If a change is refused, the cart is fetched
// again so what is shown is never something the server does not have.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "@/lib/api";

export type CartLine = {
  dishId: string;
  platform: string;
  name: string; // from the server's catalogue
  restaurant: string; // from the server's catalogue
  image?: string;
  pricePaise: number; // today's base price; checkout reprices
  qty: number;
  /**
   * The ranking this line came from, when it came from one.
   *
   * Carried per line because a cart can hold items from several
   * recommendations, and sent at checkout so each is paired with the order it
   * became. Absent for anything added by browsing the menu.
   */
  decisionId?: string;
};

type ServerCart = { lines: (CartLine & { available: boolean; addedVia: string })[]; count: number };

type CartContextValue = {
  lines: CartLine[];
  count: number;
  /** False until the server's cart has arrived the first time. */
  ready: boolean;
  add: (line: Omit<CartLine, "qty">, qty?: number) => void;
  setQty: (dishId: string, platform: string, qty: number) => void;
  remove: (dishId: string, platform: string) => void;
  clear: () => void;
  /** Fetch the cart again, after something other than this screen changed it. */
  refresh: () => void;
};

const CartContext = createContext<CartContextValue | null>(null);

/** Fired after chat changes the cart, so every mounted cart shows the change. */
export const CART_CHANGED_EVENT = "flouna:cart-changed";
export function notifyCartChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CART_CHANGED_EVENT));
}

// Where older versions of the app kept the cart in the browser. Read once,
// sent to the server, then removed.
const LOCAL_KEYS = ["flouna-cart", "radiues-cart"];

function takeLocalCart(): CartLine[] {
  const lines: CartLine[] = [];
  try {
    for (const key of LOCAL_KEYS) {
      const saved = localStorage.getItem(key);
      if (saved) lines.push(...(JSON.parse(saved) as CartLine[]));
    }
  } catch {
    // Corrupted or blocked storage: nothing to bring over.
  }
  return lines.filter((l) => l && typeof l.dishId === "string" && typeof l.platform === "string" && Number.isInteger(l.qty) && l.qty > 0);
}

function forgetLocalCart() {
  try {
    for (const key of LOCAL_KEYS) localStorage.removeItem(key);
  } catch {
    // Nothing more to do.
  }
}

const toLines = (c: ServerCart): CartLine[] =>
  c.lines.map(({ dishId, platform, name, restaurant, image, pricePaise, qty, decisionId }) => ({
    dishId,
    platform,
    name,
    restaurant,
    ...(image ? { image } : {}),
    pricePaise,
    qty,
    ...(decisionId ? { decisionId } : {}),
  }));

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [ready, setReady] = useState(false);
  // Answers can arrive out of order. Only the latest request may set the cart.
  const seq = useRef(0);

  const apply = useCallback(async (request: () => Promise<ServerCart>) => {
    const mine = ++seq.current;
    try {
      const cart = await request();
      if (mine === seq.current) setLines(toLines(cart));
    } catch {
      // Refused or offline: show what the server actually has.
      try {
        const cart = await api<ServerCart>("/api/cart");
        if (mine === seq.current) setLines(toLines(cart));
      } catch {
        // Still unreachable. Leave the screen as it is rather than empty it.
      }
    }
  }, []);

  const refresh = useCallback(() => {
    void apply(() => api<ServerCart>("/api/cart"));
  }, [apply]);

  // First load: bring over a cart an older version left in the browser, then
  // show the server's cart.
  useEffect(() => {
    const local = takeLocalCart();
    void (async () => {
      await apply(() =>
        local.length
          ? api<ServerCart>("/api/cart/import", {
              method: "POST",
              json: { lines: local.map(({ dishId, platform, qty, decisionId }) => ({ dishId, platform, qty, decisionId })) },
            })
          : api<ServerCart>("/api/cart"),
      );
      if (local.length) forgetLocalCart();
      setReady(true);
    })();
  }, [apply]);

  useEffect(() => {
    window.addEventListener(CART_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(CART_CHANGED_EVENT, refresh);
  }, [refresh]);

  const add = useCallback(
    (line: Omit<CartLine, "qty">, qty = 1) => {
      setLines((prev) => {
        const i = prev.findIndex((l) => l.dishId === line.dishId && l.platform === line.platform);
        if (i < 0) return [...prev, { ...line, qty }];
        const next = [...prev];
        next[i] = { ...next[i]!, qty: Math.min(20, next[i]!.qty + qty) };
        return next;
      });
      void apply(() =>
        api<ServerCart>("/api/cart/items", {
          method: "POST",
          json: { dishId: line.dishId, platform: line.platform, qty, ...(line.decisionId ? { decisionId: line.decisionId } : {}) },
        }),
      );
    },
    [apply],
  );

  const setQty = useCallback(
    (dishId: string, platform: string, qty: number) => {
      const n = Math.max(0, Math.min(20, qty));
      setLines((prev) =>
        n === 0
          ? prev.filter((l) => !(l.dishId === dishId && l.platform === platform))
          : prev.map((l) => (l.dishId === dishId && l.platform === platform ? { ...l, qty: n } : l)),
      );
      void apply(() => api<ServerCart>("/api/cart/items", { method: "PATCH", json: { dishId, platform, qty: n } }));
    },
    [apply],
  );

  const remove = useCallback(
    (dishId: string, platform: string) => {
      setLines((prev) => prev.filter((l) => !(l.dishId === dishId && l.platform === platform)));
      void apply(() => api<ServerCart>("/api/cart/items", { method: "DELETE", json: { dishId, platform } }));
    },
    [apply],
  );

  const clear = useCallback(() => {
    setLines([]);
    void apply(() => api<ServerCart>("/api/cart", { method: "DELETE" }));
  }, [apply]);

  const value = useMemo(
    () => ({ lines, count: lines.reduce((s, l) => s + l.qty, 0), ready, add, setQty, remove, clear, refresh }),
    [lines, ready, add, setQty, remove, clear, refresh],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart must be used inside CartProvider");
  return ctx;
}
