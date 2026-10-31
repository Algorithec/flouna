import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, H2 } from "@/components/legal/LegalPage";
import { POLICY_EFFECTIVE } from "@/lib/legal/meta";

export const metadata: Metadata = {
  title: "Delete your Flouna account",
  description:
    "How to delete your Flouna account and the data held with it, what is erased, and what the law requires us to keep.",
};

// Google Play asks every app with accounts for a public page, reachable
// without the app or a sign-in, that says how to delete an account and what
// happens to the data. The steps below are the ones the app really has
// (Profile, Your data, Delete my account), and the numbers are the ones the
// server applies: lib/policy.ts on the server, DELETION_GRACE_MS and RETENTION.
//
// The mailbox is info@algorithec.com because it receives mail today. The
// policy contacts in lib/legal/meta.ts are on algorithec.ai, which has no mail
// records yet; a deletion request sent there would be lost.
const REQUESTS_MAILBOX = "info@algorithec.com";

export default function DeleteAccountPage() {
  return (
    <LegalPage title="Delete your Flouna account" updated={POLICY_EFFECTIVE}>
      <p>
        Flouna is an app by <b>Algorithec Private Limited</b>. You can delete
        your Flouna account, and the personal data held with it, at any time.
        This page explains how, and what happens next.
      </p>

      <H2>In the app or on the website</H2>
      <ol className="ml-5 list-decimal space-y-1">
        <li>
          Sign in to the Flouna app, or at{" "}
          <Link href="/profile/data" className="font-semibold text-accent underline">
            flouna.com
          </Link>
          .
        </li>
        <li>
          Open <b>Profile</b>, then <b>Your data</b>.
        </li>
        <li>
          Tap <b>Delete my account</b> and enter your password to confirm.
        </li>
      </ol>
      <p>
        On the same screen you can download a copy of your data first, which we
        suggest, since deletion cannot be undone once it goes through.
      </p>

      <H2>If you can no longer sign in</H2>
      <p>
        Write to <a href={`mailto:${REQUESTS_MAILBOX}?subject=Delete%20my%20Flouna%20account`} className="font-semibold text-accent underline">{REQUESTS_MAILBOX}</a>{" "}
        from the email address on your account, with the subject{" "}
        <b>Delete my Flouna account</b>. We confirm the request came from you
        before acting on it, so nobody else can delete your account.
      </p>

      <H2>What happens next</H2>
      <ul className="ml-5 list-disc space-y-1">
        <li>
          <b>30 days to change your mind.</b> We hold the request for 30 days
          before erasing anything. You can still sign in during that time, and
          cancel the request from the same screen.
        </li>
        <li>
          <b>Then your personal data is erased</b>: your name, email address,
          phone number, saved addresses, saved payment methods, chat history,
          price alerts, blocked accounts, and the devices and notifications
          linked to your account.
        </li>
        <li>
          <b>Past orders are kept without your name on them.</b> Tax law
          requires transaction records to be kept for seven years, so orders and
          payments remain as anonymous records that can no longer be linked to
          you.
        </li>
        <li>
          <b>Payment details</b> are held by our payment provider, Cashfree, not
          by Flouna, and are not part of your Flouna account.
        </li>
      </ul>

      <p>
        For more on what we collect and why, see the{" "}
        <Link href="/legal/privacy" className="font-semibold text-accent underline">
          Privacy Policy
        </Link>
        .
      </p>
    </LegalPage>
  );
}
