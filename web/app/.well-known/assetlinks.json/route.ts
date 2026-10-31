import { NextResponse } from "next/server";

// Digital Asset Links — proves flouna.com and the Android app are the same
// owner. Without this served over HTTPS at exactly
// /.well-known/assetlinks.json, a Trusted Web Activity falls back to showing
// a browser URL bar and stops looking like an installed app.
//
// ANDROID_SIGNING_SHA256 holds the SHA-256 of each key the app can be signed
// with, comma separated: Google Play re-signs the app with its own app signing
// key, so the list needs that one (Play Console, App integrity) and, for builds
// installed before Play, the upload key. Each is 32 bytes as uppercase hex,
// colon separated. A value in any other shape is left out rather than
// published, since a malformed fingerprint fails verification silently on the
// phone. Until one is set the route returns an empty list rather than a wrong
// claim. Read at build time: set it on the web service before deploying.
export const dynamic = "force-static";

const FINGERPRINT = /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/;

export function GET() {
  const fingerprints = (process.env.ANDROID_SIGNING_SHA256 ?? "")
    .split(",")
    .map((f) => f.trim().toUpperCase())
    .filter((f) => FINGERPRINT.test(f));
  const packageName = process.env.ANDROID_PACKAGE_NAME ?? "com.flouna.app";

  const statements =
    fingerprints.length > 0
      ? [
          {
            relation: ["delegate_permission/common.handle_all_urls"],
            target: {
              namespace: "android_app",
              package_name: packageName,
              sha256_cert_fingerprints: [...new Set(fingerprints)],
            },
          },
        ]
      : [];

  return NextResponse.json(statements, {
    headers: { "content-type": "application/json" },
  });
}
