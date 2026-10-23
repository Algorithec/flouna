"use client";

import { useSyncExternalStore } from "react";

// Shake the phone to report a technical problem, as Instagram does.
//
// The choice is kept per device, like the theme: whether shaking should do
// anything depends on the phone in your hand, not on your account. It is on by
// default wherever the browser hands out motion readings freely (Android).
// iPhones and iPads only give them after the person allows it from a tap, so
// there it starts off and the Settings switch asks.

const KEY = "flouna.shakeToReport";
const CHANGE = "flouna:shake-setting";
/** Opens the report sheet from anywhere (Settings, Help) without a shake. */
export const OPEN_REPORT_EVENT = "flouna:report-problem";

type MotionPermission = { requestPermission?: () => Promise<"granted" | "denied"> };

/** A phone or tablet whose browser reports motion. A laptop with a touchpad is not one. */
export function shakeSupported(): boolean {
  if (typeof window === "undefined" || !("DeviceMotionEvent" in window)) return false;
  return window.matchMedia?.("(pointer: coarse)").matches ?? false;
}

function canAskPermission(): boolean {
  return typeof (window.DeviceMotionEvent as unknown as MotionPermission).requestPermission === "function";
}

/**
 * Whether motion readings stay off until the person allows them. Chrome now
 * has requestPermission too but grants it without asking, so having the
 * function is not the test: only Apple's browsers hold the readings back.
 * An iPad asking for the desktop site reports itself as a Mac with a touch screen.
 */
function needsPermission(): boolean {
  if (!canAskPermission()) return false;
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

function readEnabled(): boolean {
  if (!shakeSupported()) return false;
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(KEY);
  } catch {
    // Storage blocked: fall back to the default below.
  }
  if (stored === "1") return true;
  if (stored === "0") return false;
  return !needsPermission();
}

function subscribe(cb: () => void) {
  window.addEventListener(CHANGE, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(CHANGE, cb);
    window.removeEventListener("storage", cb);
  };
}

export function useShakeEnabled(): boolean {
  return useSyncExternalStore(subscribe, readEnabled, () => false);
}

/**
 * Turns shake to report on or off. Must be called from a tap: on an iPhone,
 * turning it on asks for motion access, and that prompt only appears in
 * answer to one. Returns whether it ended up on.
 */
export async function setShakeEnabled(on: boolean): Promise<boolean> {
  if (on && canAskPermission()) {
    try {
      const answer = await (window.DeviceMotionEvent as unknown as MotionPermission).requestPermission!();
      if (answer !== "granted") return false;
    } catch {
      return false;
    }
  }
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    // Not remembered, but still applies for this visit.
  }
  window.dispatchEvent(new Event(CHANGE));
  return on;
}

/**
 * Calls onShake when the phone is shaken: three sharp jolts within a second.
 * One bump, a step or a car going over a speed breaker is a single jolt and
 * does nothing. After a shake it stays quiet for a few seconds, so one
 * vigorous shake opens one sheet.
 */
export function listenForShake(onShake: () => void): () => void {
  const JOLT = 25; // m/s², summed change across the three axes between readings
  const WINDOW_MS = 1000;
  const QUIET_MS = 3000;
  let last: { x: number; y: number; z: number } | null = null;
  let jolts: number[] = [];
  let quietUntil = 0;

  const onMotion = (e: DeviceMotionEvent) => {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null || a.y == null || a.z == null) return;
    const now = Date.now();
    if (last) {
      const change = Math.abs(a.x - last.x) + Math.abs(a.y - last.y) + Math.abs(a.z - last.z);
      if (change > JOLT && now >= quietUntil) {
        jolts = jolts.filter((t) => now - t < WINDOW_MS);
        jolts.push(now);
        if (jolts.length >= 3) {
          jolts = [];
          quietUntil = now + QUIET_MS;
          onShake();
        }
      }
    }
    last = { x: a.x, y: a.y, z: a.z };
  };

  window.addEventListener("devicemotion", onMotion);
  return () => window.removeEventListener("devicemotion", onMotion);
}
