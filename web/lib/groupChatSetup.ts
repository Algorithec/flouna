"use client";

import { api } from "@/lib/api";
import {
  cryptoAvailable,
  deviceId,
  deviceLabel,
  publicKeys,
  ownChain,
  distributionFor,
  type MemberDevice,
} from "@/lib/groupCrypto";

// Getting a device into a conversation before anyone speaks in it.
//
// A sender key distribution message carries the chain at its CURRENT position,
// so a device that appears after a message was sent cannot read that message —
// that is the forward secrecy, and it is the correct behaviour. The practical
// consequence is that a device has to exist EARLY, not at the moment its owner
// first opens the chat, or they miss everything said in between.
//
// So this runs from the group screens too, not only the chat: being in the cart
// is what registers you, the way being in a WhatsApp group registers your
// phone whether or not you have the thread open.

export type KeysResponse = {
  devices: MemberDevice[];
  inbound: {
    senderId: string;
    senderDevice: string;
    senderKey: string;
    iv: string;
    payload: string;
  }[];
  owed: { userId: string; deviceId: string; publicKey: string }[];
  history: { fromDevice: string; senderKey: string; iv: string; payload: string } | null;
};

/**
 * Publishes this device's keys against the ACCOUNT.
 *
 * Called once when the app loads, so a device is known before it is needed. A
 * distribution message carries the sender's chain at its current position, so a
 * device that only becomes known when its owner opens a particular chat has
 * already missed everything said before that moment. Registering at sign-in is
 * what makes the difference between a member reading their group and a member
 * finding it locked.
 */
export async function registerDevice(): Promise<string | null> {
  if (!cryptoAvailable()) return null;
  const me = deviceId();
  const { publicKey, signingKey } = await publicKeys();
  await api("/api/users/chat-device", {
    method: "POST",
    json: { deviceId: me, publicKey, signingKey, label: deviceLabel() },
  });
  return me;
}

/** Fire-and-forget registration for the signed-in shell. */
export async function registerDeviceQuietly(): Promise<void> {
  try {
    await registerDevice();
  } catch {
    /* a device that fails to register retries on the next screen that needs it */
  }
}

/**
 * Hands this device's chain to every member device that does not have it yet.
 *
 * Returns the response so a caller that wants more from it — inbound chains,
 * a waiting history — does not have to fetch twice.
 */
export async function publishOwedChains(
  cartId: string,
  me: string,
): Promise<KeysResponse> {
  const keys = await api<KeysResponse>(`/api/groups/${cartId}/chat/keys?deviceId=${me}`);
  if (keys.owed.length > 0) {
    const envelopes = [];
    for (const d of keys.owed) {
      const sealed = await distributionFor(cartId, d as MemberDevice);
      envelopes.push({ recipientId: d.userId, recipientDevice: d.deviceId, ...sealed });
    }
    // The server takes at most 60 a request. A group whose members have more
    // devices than that between them was refused outright, so its chains
    // never reached anyone.
    for (let i = 0; i < envelopes.length; i += 60) {
      await api(`/api/groups/${cartId}/chat/keys`, {
        method: "POST",
        json: { senderDevice: me, envelopes: envelopes.slice(i, i + 60) },
      }).catch(() => {});
    }
  }
  return keys;
}

/**
 * Register and publish, for screens that are not the chat.
 *
 * Quiet on failure by design: a member browsing the menu should not be shown a
 * crypto error for a conversation they have not opened.
 */
export async function joinChatQuietly(cartId: string): Promise<void> {
  try {
    if (!cryptoAvailable()) return;
    const me = await registerDevice();
    if (!me) return;
    await ownChain(cartId);
    await publishOwedChains(cartId, me);
  } catch {
    /* nothing to say here */
  }
}
