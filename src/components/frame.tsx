import Link from "next/link";
import type { ReactNode } from "react";

type Tab = "house" | "chores" | "settle" | "settings";

/**
 * The top of every signed-in page: the wordmark and the places you can go. Houses that settle up
 * by e-Transfer also get a "Settle up" tab.
 */
export function Masthead({ current, settle = false }: { current?: Tab; settle?: boolean }) {
  const tabs: [Tab, string, string][] = [
    ["house", "House", "/house"],
    ["chores", "Chores", "/house/chores"],
    ...(settle ? ([["settle", "Settle up", "/settle"]] as [Tab, string, string][]) : []),
    ["settings", "Settings", "/house/settings"],
  ];
  return (
    <header className="masthead">
      <Link href="/house" className="wordmark">
        Housepot
      </Link>
      <nav className="nav" aria-label="Main">
        {tabs.map(([key, label, href]) => (
          <Link key={key} href={href} aria-current={current === key ? "page" : undefined}>
            {label}
          </Link>
        ))}
      </nav>
    </header>
  );
}

/** The plain top used before someone is in a house. */
export function PlainMasthead({ children }: { children?: ReactNode }) {
  return (
    <header className="masthead">
      <Link href="/" className="wordmark">
        Housepot
      </Link>
      <nav className="nav">{children}</nav>
    </header>
  );
}

type Params = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** A one-line message carried in the address after an action: ?notice=… or ?error=… */
export function Flash({ params }: { params: Params }) {
  const error = first(params.error);
  const notice = first(params.notice);
  if (error) {
    return (
      <p className="flash flash-error" role="alert">
        {error}
      </p>
    );
  }
  if (notice) {
    return (
      <p className="flash flash-notice" role="status">
        {notice}
      </p>
    );
  }
  return null;
}

export const param = first;
