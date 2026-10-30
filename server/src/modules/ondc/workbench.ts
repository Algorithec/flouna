import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { workbenchUrlProblem } from "./context.js";
import { GATEWAY_URL } from "./transport.js";

// ONDC's workbench runs its certification flows against a mock seller, which
// answers at an address of its own for each domain and version. Searches by
// the accounts in ONDC_SEARCH_TESTERS go there while ONDC_WORKBENCH_URL is set,
// so the flows can be driven from the live app. Everyone else's still go to
// the gateway, and so does every search once it is unset. Select, init and
// confirm need nothing here: they go to the bpp_uri the seller answered from.

/** The versions we speak, which name the mock seller's address. */
const VERSION = { "ONDC:RET11": "1.2.0", "ONDC:TRV10": "2.0.1" } as const;
export type SearchDomain = keyof typeof VERSION;

/** Whether this account is one of ONDC_SEARCH_TESTERS. */
export async function isOndcTester(userId: string, testers: Set<string> = env.ONDC_SEARCH_TESTERS): Promise<boolean> {
  if (testers.size === 0) return false;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  return Boolean(user && testers.has(user.email.toLowerCase()));
}

/** Where this customer's search goes: the workbench's mock seller for a tester while it is set, else the gateway. */
export async function searchUrl(
  userId: string,
  domain: SearchDomain,
  config: { workbench?: string; testers: Set<string>; registry: keyof typeof GATEWAY_URL } = {
    workbench: env.ONDC_WORKBENCH_URL,
    testers: env.ONDC_SEARCH_TESTERS,
    registry: env.ONDC_REGISTRY_ENV,
  },
): Promise<string> {
  const gateway = GATEWAY_URL[config.registry];
  // The workbench is a pre-production tool. Production searches never go there,
  // whoever is searching, and neither does anything when the address is unsafe.
  if (!config.workbench || config.registry !== "preprod" || workbenchUrlProblem(config.workbench)) return gateway;
  if (!(await isOndcTester(userId, config.testers))) return gateway;
  return `${config.workbench.replace(/\/+$/, "")}/${domain}/${VERSION[domain]}/seller`;
}
