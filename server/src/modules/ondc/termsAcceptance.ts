import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

// The record static terms 17.6.1 asks for: which version of our terms each
// seller app accepted, who accepted, when and how.
//
// ONDC's way of agreeing to a buyer app's terms is to transact under them. Our
// search states the terms (bap_terms: their address and effective date); a
// seller that answers it, is ordered from, and confirms the order with its
// signed on_confirm has accepted them for that order. The first such order
// for each seller app and version is kept as the evidence, with the signed
// message's id so the message itself can be produced from the transaction log.

type Wire = Record<string, unknown>;
const obj = (v: unknown): Wire => (v && typeof v === "object" && !Array.isArray(v) ? (v as Wire) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Whether the seller also said so outright: bpp_terms accept_bap_terms "Y". */
export function statesAcceptance(body: unknown): boolean {
  const tags = arr(obj(obj(obj(body).message).order).tags).map(obj);
  const bpp = tags.find((t) => t.code === "bpp_terms");
  return arr(bpp?.list)
    .map(obj)
    .some((e) => e.code === "accept_bap_terms" && typeof e.value === "string" && e.value.trim().toUpperCase() === "Y");
}

export async function recordTermsAcceptance(a: {
  bppId: string;
  termsUrl: string;
  termsEffective: string;
  orderId: string;
  messageId: string;
  at: Date;
  statedAccept: boolean;
}) {
  const key = { bppId_termsUrl_termsEffective: { bppId: a.bppId, termsUrl: a.termsUrl, termsEffective: a.termsEffective } };
  const update = {
    lastAcceptedAt: a.at,
    ordersAccepted: { increment: 1 },
    // Once said outright it stays said; a later order without the tag does not unsay it.
    ...(a.statedAccept ? { statedAccept: true } : {}),
  };
  const upsert = () =>
    prisma.ondcTermsAcceptance.upsert({
      where: key,
      create: {
        bppId: a.bppId,
        termsUrl: a.termsUrl,
        termsEffective: a.termsEffective,
        firstOrderId: a.orderId,
        firstMessageId: a.messageId,
        firstAcceptedAt: a.at,
        lastAcceptedAt: a.at,
        statedAccept: a.statedAccept,
      },
      update,
    });
  try {
    await upsert();
  } catch (err) {
    // Two first orders from the same seller confirmed at once: both tried to
    // create the row. The loser counts its order against the winner's row.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      await prisma.ondcTermsAcceptance.update({ where: key, data: update });
      return;
    }
    throw err;
  }
}

export function listTermsAcceptances() {
  return prisma.ondcTermsAcceptance.findMany({ orderBy: [{ bppId: "asc" }, { firstAcceptedAt: "desc" }], take: 500 });
}
