/** How often an open page asks the server whether anything changed. */
export const REFRESH_EVERY_MS = 10_000;

type PageState = {
  /** The tab is in the background, or the phone is locked. */
  hidden: boolean;
  /** The person is in the middle of typing or choosing something. */
  editing: boolean;
  /** A form on the page is being sent right now. */
  busy: boolean;
};

/**
 * Whether to fetch fresh data now. Never for a page nobody is looking at (it would keep the
 * database awake for nothing), and never under someone's fingers.
 */
export function shouldRefresh(state: PageState): boolean {
  return !state.hidden && !state.editing && !state.busy;
}
