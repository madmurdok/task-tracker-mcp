import { execFile } from "node:child_process";

/**
 * Picks the OS's own "open this URL with the default handler" command. This
 * is also what gets "reuse an already-open browser/tab" for free - the OS
 * hands the URL to the default-browser handler, which is what decides to
 * open a new tab in an already-running browser instead of a second window
 * (virtually every browser does this by default). Scripting a *specific*
 * existing tab instead would mean per-browser, per-OS automation (AppleScript
 * on macOS only, etc.) - disproportionate for a local dev tool, so this
 * doesn't attempt it.
 */
export function browserOpenCommand(platform: NodeJS.Platform, url: string): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [url] };
  // "start" is a cmd.exe builtin, not a standalone executable - must go
  // through cmd /c. The empty "" arg is a required placeholder window title;
  // without it, `start` treats the URL itself as the title instead of the
  // target to open.
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

/**
 * Best-effort - a missing xdg-open (headless/SSH session) or any other
 * failure just logs a warning. Must never take the still-running dashboard
 * server down over a browser that couldn't be opened.
 */
export function openInBrowser(url: string): void {
  const { command, args } = browserOpenCommand(process.platform, url);
  execFile(command, args, (error) => {
    if (error) {
      console.warn(`Could not open a browser automatically: ${error.message}. Open ${url} manually.`);
    }
  });
}
