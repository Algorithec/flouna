import { prisma } from "../../lib/prisma.js";

/**
 * How many chat devices an account keeps. Each signed-in browser is one, so
 * this covers a phone, a laptop and a handful of others; a device past it has
 * not been seen for longer than all of them.
 */
export const MAX_CHAT_DEVICES = 10;

/**
 * Registers (or refreshes) one of the caller's chat devices, and retires the
 * account's least recently seen devices beyond the limit.
 *
 * Nothing used to retire a device, so an account gathered one per browser,
 * private window and cleared cache: 161 on one account. Each member then owed
 * a chain to every one of them, more than one upload may carry, and the chat
 * stopped working for everyone in the group. The app registers its device on
 * every visit, so a device in use is always among the most recently seen and
 * is never the one retired; a retired device that returns simply registers
 * again and is sent fresh chains.
 */
export async function registerChatDevice(
  userId: string,
  input: { deviceId: string; publicKey: string; signingKey: string; label?: string },
) {
  const { deviceId, publicKey, signingKey, label } = input;
  const existing = await prisma.chatDevice.findUnique({
    where: { userId_deviceId: { userId, deviceId } },
    select: { publicKey: true },
  });
  const rekeyed = Boolean(existing && existing.publicKey !== publicKey);

  const device = await prisma.chatDevice.upsert({
    where: { userId_deviceId: { userId, deviceId } },
    create: { userId, deviceId, publicKey, signingKey, label },
    update: { publicKey, signingKey, label, lastSeenAt: new Date() },
    select: { deviceId: true, publicKey: true, signingKey: true, createdAt: true },
  });

  // A device whose key changed cannot open anything sealed to the old one,
  // so those are dropped and senders re-seal rather than leaving it holding
  // post it will never open.
  if (rekeyed) await dropInbound(userId, [deviceId]);

  const retired = await prisma.chatDevice.findMany({
    where: { userId, deviceId: { not: deviceId } },
    orderBy: [{ lastSeenAt: "desc" }, { createdAt: "desc" }],
    skip: MAX_CHAT_DEVICES - 1,
    select: { deviceId: true },
  });
  if (retired.length) {
    const ids = retired.map((d) => d.deviceId);
    await prisma.chatDevice.deleteMany({ where: { userId, deviceId: { in: ids } } });
    await dropInbound(userId, ids);
  }

  return { device, rekeyed };
}

/** What was waiting for these devices, which can no longer be opened. */
async function dropInbound(userId: string, deviceIds: string[]) {
  await prisma.senderKeyEnvelope.deleteMany({
    where: { recipientId: userId, recipientDevice: { in: deviceIds } },
  });
  await prisma.historySync.deleteMany({ where: { userId, toDevice: { in: deviceIds } } });
}
