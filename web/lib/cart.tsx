"use client";

// Client-side cart: dish lines the user is assembling before checkout. Only
// ids + quantities live here — every price is recomputed by the server at
// order time, so a tampered localStorage can't change what's charged.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type CartLine = {
  dishId: string;
  platform: string;
  name: string; // display-only snapshot
  restaurant: string; // display-only snapshot
  pricePaise: number; // display-only estimate; server reprices
  qty: number;
};

type CartContextValue = {
  lines: CartLine[];
  count: number;
  add: (line: Omit<CartLine, "qty">, qty?: number) => void;
  setQty: (dishId: string, platform: string, qty: number) => void;
  remove: (dishId: string, platform: string) => void;
  clear: () => void;
};

const CartContext = createContext<CartContextValue | null>(null);
const STORAGE_KEY = "radiues-cart";

export function CartProvider({ children }: { children: React.ReactNode }) {
  // Lazy hydration from localStorage — safe here because this provider mounts
  // behind the client-side auth gate, after hydration.
  const [lines, setLines] = useState<CartLine[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as CartLine[];
    } catch {
      return []; // corrupted storage — start empty
    }
  });

  // Persist on every change.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(lines));
    } catch {
      /* storage full/blocked — cart still works in memory */
    }
  }, [lines]);

  const add = useCallback((line: Omit<CartLine, "qty">, qty = 1) => {
    setLines((prev) => {
      const i = prev.findIndex(
        (l) => l.dishId === line.dishId && l.platform === line.platform,
      );
      if (i >= 0) {
        const next = [...prev];
        next[i] = { ...next[i]!, qty: Math.min(20, next[i]!.qty + qty) };
        return next;
      }
      return [...prev, { ...line, qty }];
    });
  }, []);

  const setQty = useCallback((dishId: string, platform: string, qty: number) => {
    setLines((prev) =>
      qty <= 0
        ? prev.filter((l) => !(l.dishId === dishId && l.platform === platform))
        : prev.map((l) =>
            l.dishId === dishId && l.platform === platform
              ? { ...l, qty: Math.min(20, qty) }
              : l,
          ),
    );
  }, []);

  const remove = useCallback((dishId: string, platform: string) => {
    setLines((prev) =>
      prev.filter((l) => !(l.dishId === dishId && l.platform === platform)),
    );
  }, []);

  const clear = useCallback(() => setLines([]), []);

  const value = useMemo(
    () => ({
      lines,
      count: lines.reduce((s, l) => s + l.qty, 0),
      add,
      setQty,
      remove,
      clear,
    }),
    [lines, add, setQty, remove, clear],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart must be used inside CartProvider");
  return ctx;
}
