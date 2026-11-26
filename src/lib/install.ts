/**
 * Which "add to home screen" steps to show, from the browser's user agent. Null means show nothing:
 * the person is on a computer, or Housepot is already running from their home screen.
 */
export function installSteps(userAgent: string, standalone: boolean): "ios" | "android" | null {
  if (standalone) return null;
  if (/iPhone|iPad|iPod/.test(userAgent)) return "ios";
  if (/Android/.test(userAgent)) return "android";
  return null;
}
