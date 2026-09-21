import { afterEach, expect, it, vi } from "vitest";
import { isSidebarPresence, SIDEBAR_PRESENCE_PORT, openSidePanelFromPage } from "../src/page-bridge";
import { emptyLibrary, pageToolEnabled } from "../src/model";

const origin = "chrome-extension://localmark-test";
function presence(sender: chrome.runtime.MessageSender, name = SIDEBAR_PRESENCE_PORT) {
  vi.stubGlobal("chrome", { runtime: { id: "localmark-test", getURL: (path: string) => `${origin}/${path}` } });
  return isSidebarPresence({ name, sender });
}
afterEach(() => vi.unstubAllGlobals());

it("opens only the sender's window immediately without losing the click to async work", async () => {
  const open = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("chrome", { runtime: { id: "localmark-test" }, sidePanel: { open } });
  const sender = { id: "localmark-test", frameId: 0, url: "https://example.com", tab: { windowId: 7 } as chrome.tabs.Tab };
  const result = openSidePanelFromPage(sender);
  expect(open).toHaveBeenCalledWith({ windowId: 7 });
  await result;
  expect(() => openSidePanelFromPage({ ...sender, frameId: 2 })).toThrow();
  expect(() => openSidePanelFromPage({ ...sender, id: "other" })).toThrow();
  expect(() => openSidePanelFromPage({ ...sender, tab: undefined })).toThrow();
  expect(open).toHaveBeenCalledTimes(1);
});

it("defaults all buttons on, preserves the old hidden preference and allows independent overrides", () => {
  const lib = emptyLibrary();
  for (const tool of ["element", "visibility", "sidebar"] as const) expect(pageToolEnabled(lib, tool)).toBe(true);
  lib.showPageTools = false;
  for (const tool of ["element", "visibility", "sidebar"] as const) expect(pageToolEnabled(lib, tool)).toBe(false);
  lib.pageTools = { sidebar: true };
  expect(pageToolEnabled(lib, "sidebar")).toBe(true);
  expect(pageToolEnabled(lib, "element")).toBe(false);
});

it("accepts native sidebar senders with a full URL or Chrome 128's origin only", () => {
  expect(presence({ id: "localmark-test", url: `${origin}/sidepanel.html`, origin })).toBe(true);
  expect(presence({ id: "localmark-test", origin })).toBe(true);
});
it("rejects webpages, other extensions, other documents and unrelated ports", () => {
  expect(presence({ id: "localmark-test", origin: "https://example.com" })).toBe(false);
  expect(presence({ id: "another-extension", origin })).toBe(false);
  expect(presence({ id: "localmark-test", url: `${origin}/settings.html`, origin })).toBe(false);
  expect(presence({ id: "localmark-test", origin, tab: { id: 2 } as chrome.tabs.Tab })).toBe(false);
  expect(presence({ id: "localmark-test" })).toBe(false);
  expect(presence({ id: "localmark-test", origin }, "another-port")).toBe(false);
});
