"use client";

import { type ReactNode, useState } from "react";
import { useFormStatus } from "react-dom";

type SubmitProps = { children: ReactNode; className?: string; pendingLabel?: string; disabled?: boolean };

/** A submit button that greys out and changes its label while its form is being sent. */
export function SubmitButton({
  children,
  className = "btn",
  pendingLabel = "Working…",
  disabled = false,
}: SubmitProps) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending || disabled}>
      {pending ? pendingLabel : children}
    </button>
  );
}

const MAX_EDGE = 1600;

/** Shrinks a phone photo to a sensible size before upload. Falls back to the original on any problem. */
async function shrink(file: File): Promise<File> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
    return blob ? new File([blob], "proof.jpg", { type: "image/jpeg" }) : file;
  } catch {
    return file;
  }
}

function CameraIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M4 8.5h3l1.6-2.5h6.8L17 8.5h3a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9.5a1 1 0 0 1 1-1Z" />
      <circle cx="12" cy="13.5" r="3.4" />
    </svg>
  );
}

/** Most photos one proof can have. Matches MAX_PHOTOS on the server. */
const MAX_PHOTOS = 4;

/**
 * A button that opens the camera or the photo library. Choosing one to four photos sends the
 * surrounding form straight away, so "done" is one tap. Extra photos past four are dropped.
 */
export function PhotoSubmit({ label, className = "btn btn-primary" }: { label: string; className?: string }) {
  const { pending } = useFormStatus();
  const [preparing, setPreparing] = useState(false);
  const busy = pending || preparing;
  return (
    <label className={className} aria-disabled={busy}>
      <CameraIcon />
      {busy ? "Uploading…" : label}
      <input
        type="file"
        name="photo"
        accept="image/*"
        multiple
        className="visually-hidden"
        onChange={async (e) => {
          const input = e.currentTarget;
          const files = [...(input.files ?? [])].slice(0, MAX_PHOTOS);
          if (files.length === 0) return;
          setPreparing(true);
          try {
            const swap = new DataTransfer();
            for (const file of files) swap.items.add(await shrink(file));
            input.files = swap.files;
          } catch {
            // Keep the original files.
          }
          input.form?.requestSubmit();
          setPreparing(false);
        }}
      />
    </label>
  );
}

/** Copies the invite link, or opens the phone's share sheet when there is one. */
export function ShareLink({ url, houseName }: { url: string; houseName: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn"
      onClick={async () => {
        try {
          if (navigator.share) {
            await navigator.share({ title: `Join ${houseName} on Housepot`, url });
            return;
          }
          await navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          // The person closed the share sheet, or the clipboard is blocked. Nothing to do.
        }
      }}
    >
      {copied ? "Copied" : "Share"}
    </button>
  );
}

/** Copies one value (an email, a code, an amount) so it can be pasted into the bank's e-Transfer form. */
export function CopyButton({
  value,
  label,
  className = "btn",
}: {
  value: string;
  label: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // The clipboard is blocked. The value is shown on screen to copy by hand.
        }
      }}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

/** Shows only the schedule fields that match the chosen repeat (weekly, or every N days). */
export function ScheduleFields({ children, initial }: { children: ReactNode; initial: string }) {
  const [kind, setKind] = useState(initial);
  return (
    <div
      className="schedule"
      data-kind={kind}
      onChange={(e) => {
        const target = e.target as unknown as HTMLSelectElement;
        if (target.name === "scheduleKind") setKind(target.value);
      }}
    >
      {children}
    </div>
  );
}
