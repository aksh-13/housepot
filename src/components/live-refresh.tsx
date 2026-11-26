"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { REFRESH_EVERY_MS, shouldRefresh } from "@/lib/live";

/**
 * Keeps a page current without anyone reloading it: when a housemate adds a bill or does a chore,
 * it shows up here within a few seconds. The page re-reads its data every ten seconds while it is
 * on screen, and straight away when the person comes back to it. It renders nothing.
 */
export function LiveRefresh() {
  const router = useRouter();

  useEffect(() => {
    const refresh = () => {
      const active = document.activeElement;
      const editing =
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active instanceof HTMLSelectElement;
      // A submit button is disabled while its form is being sent (see SubmitButton).
      const busy = document.querySelector('button[type="submit"]:disabled') !== null;
      if (shouldRefresh({ hidden: document.hidden, editing, busy })) router.refresh();
    };
    const timer = window.setInterval(refresh, REFRESH_EVERY_MS);
    // Coming back to the tab or the app: catch up at once instead of waiting for the next tick.
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [router]);

  return null;
}
