import { describe, expect, it } from "vitest";
import { browserOpenCommand } from "../src/dashboard/openBrowser.js";

describe("browserOpenCommand", () => {
  it("uses macOS's open on darwin", () => {
    expect(browserOpenCommand("darwin", "http://127.0.0.1:4321/")).toEqual({
      command: "open",
      args: ["http://127.0.0.1:4321/"],
    });
  });

  it("goes through cmd /c start with an empty title placeholder on win32", () => {
    expect(browserOpenCommand("win32", "http://127.0.0.1:4321/")).toEqual({
      command: "cmd",
      args: ["/c", "start", "", "http://127.0.0.1:4321/"],
    });
  });

  it("falls back to xdg-open for linux", () => {
    expect(browserOpenCommand("linux", "http://127.0.0.1:4321/")).toEqual({
      command: "xdg-open",
      args: ["http://127.0.0.1:4321/"],
    });
  });

  it("falls back to xdg-open for any other unix-like platform, not just linux", () => {
    expect(browserOpenCommand("freebsd", "http://127.0.0.1:4321/")).toEqual({
      command: "xdg-open",
      args: ["http://127.0.0.1:4321/"],
    });
  });
});
