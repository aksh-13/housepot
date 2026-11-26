"use client";

import { useEffect, useState } from "react";
import { installSteps } from "@/lib/install";

const DISMISSED_KEY = "housepot-install-hint";

/** Chrome on Android fires this when the page can be installed, and lets us ask at a moment we choose. */
type InstallPrompt = Event & { prompt: () => Promise<void> };

/**
 * A one-time nudge, on phones only, to put Housepot on the home screen. On Android it offers a
 * one-tap Install button when the browser allows it; otherwise it says where to tap. It goes away
 * for good when dismissed, and never shows once Housepot is running from the home screen.
 */
export function InstallHint() {
  const [steps, setSteps] = useState<"ios" | "android" | null>(null);
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);

  useEffect(() => {
    // Decided after the page loads: the server cannot know what device this is or what was dismissed.
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    let dismissed = false;
    try {
      dismissed = window.localStorage.getItem(DISMISSED_KEY) === "1";
    } catch {
      // Private browsing can refuse storage. The hint then simply shows each visit.
    }
    if (!dismissed) setSteps(installSteps(navigator.userAgent, standalone));

    const onPrompt = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallPrompt);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  if (!steps) return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // See above.
    }
    setSteps(null);
  };

  return (
    <aside className="install-hint" aria-label="Add Housepot to your home screen">
      <div>
        <strong>Put Housepot on your home screen</strong>
        <p>
          {steps === "ios"
            ? 'Tap the Share button (the square with an arrow), then "Add to Home Screen". It opens like an app.'
            : prompt
              ? "It opens like an app, with its own icon."
              : 'Open the browser menu (⋮), then "Install app" or "Add to Home screen". It opens like an app.'}
        </p>
      </div>
      <div className="install-hint-actions">
        {steps === "android" && prompt && (
          <button
            type="button"
            className="btn btn-accent btn-small"
            onClick={async () => {
              await prompt.prompt();
              dismiss();
            }}
          >
            Install
          </button>
        )}
        <button type="button" className="btn btn-small" onClick={dismiss}>
          {steps === "android" && prompt ? "Not now" : "Got it"}
        </button>
      </div>
    </aside>
  );
}
