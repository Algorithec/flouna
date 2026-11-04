/** True inside the Flouna Android app, whose WebView adds this to its user agent. */
export function isAndroidApp() {
  return typeof navigator !== "undefined" && navigator.userAgent.includes("FlounaAndroid/");
}
