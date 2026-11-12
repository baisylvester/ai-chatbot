"use client";

import { useEffect, useState } from "react";
import type { SimpleResult } from "@/app/(platform)/agent/actions";

type State = "checking" | "unsupported" | "blocked" | "off" | "on" | "working";

const SERVICE_WORKER = "/agent-sw.js";

function keyBytes(base64Url: string): Uint8Array<ArrayBuffer> {
  const text = atob(base64Url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64Url.length / 4) * 4, "="));
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

/** Turns new-mail notifications on or off for this device (phone or computer). */
export function PushToggle({ vapidPublicKey, save, remove }: {
  vapidPublicKey: string | null;
  save: (endpoint: string) => Promise<SimpleResult>;
  remove: (endpoint: string) => Promise<SimpleResult>;
}) {
  const [state, setState] = useState<State>("checking");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!vapidPublicKey || !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported" as const;
      if (Notification.permission === "denied") return "blocked" as const;
      const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER);
      return (await registration?.pushManager.getSubscription()) ? ("on" as const) : ("off" as const);
    })().then((next) => { if (!cancelled) setState(next); }, () => { if (!cancelled) setState("unsupported"); });
    return () => { cancelled = true; };
  }, [vapidPublicKey]);

  async function enable() {
    setState("working");
    setError(null);
    try {
      if ((await Notification.requestPermission()) !== "granted") { setState(Notification.permission === "denied" ? "blocked" : "off"); return; }
      await navigator.serviceWorker.register(SERVICE_WORKER);
      const registration = await navigator.serviceWorker.ready;
      const subscription = (await registration.pushManager.getSubscription())
        ?? (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(vapidPublicKey!) }));
      const result = await save(subscription.endpoint);
      if ("error" in result) { await subscription.unsubscribe(); setError(result.error); setState("off"); return; }
      setState("on");
    } catch {
      setError("Notifications could not be turned on in this browser.");
      setState("off");
    }
  }

  async function disable() {
    setState("working");
    setError(null);
    try {
      const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER);
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) { await remove(subscription.endpoint); await subscription.unsubscribe(); }
      setState("off");
    } catch {
      setError("Notifications could not be turned off. Try again.");
      setState("on");
    }
  }

  const button = "rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900";
  return (
    <div className="text-sm">
      {state === "checking" && <p className="text-zinc-500">Checking this device…</p>}
      {state === "unsupported" && (
        <p className="text-zinc-600 dark:text-zinc-400">
          {vapidPublicKey
            ? "This browser can't receive notifications here. On iPhone or iPad, add this page to the Home Screen first, then open it from there."
            : "Notifications are not set up on this server yet."}
        </p>
      )}
      {state === "blocked" && <p className="text-zinc-600 dark:text-zinc-400">Notifications are blocked for this site. Allow them in the browser&apos;s site settings, then reload.</p>}
      {(state === "off" || state === "on" || state === "working") && (
        <div className="flex flex-wrap items-center gap-3">
          <span role="status" className={state === "on" ? "font-medium text-emerald-700 dark:text-emerald-400" : "text-zinc-600 dark:text-zinc-400"}>
            {state === "on" ? "On for this device" : state === "working" ? "Working…" : "Off for this device"}
          </span>
          <button type="button" className={button} disabled={state === "working"} onClick={state === "on" ? disable : enable}>
            {state === "on" ? "Turn off" : "Notify me about new mail"}
          </button>
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
