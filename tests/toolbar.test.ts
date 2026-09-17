import { afterEach, expect, it, vi } from "vitest";
import { ensurePageBridge } from "../src/toolbar";

function api() {
  const chrome = {
    tabs: { sendMessage: vi.fn().mockResolvedValue({ ready: true, url: "https://example.com/article", version: "0.1.15" }) },
    scripting: {
      insertCSS: vi.fn().mockResolvedValue([]),
      executeScript: vi.fn().mockResolvedValue([]),
    },
    runtime: { openOptionsPage: vi.fn().mockResolvedValue(undefined) },
    action: {
      setBadgeText: vi.fn().mockResolvedValue(undefined),
      setTitle: vi.fn().mockResolvedValue(undefined),
    },
  };
  vi.stubGlobal("chrome", chrome);
  return chrome;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const tab = { id: 7, url: "https://example.com/article" } as chrome.tabs.Tab;

it("native panel connects to an existing page without injecting or toggling", async () => {
  const c = api();
  const info = await ensurePageBridge(tab.id!);
  expect(info.url).toBe(tab.url);
  expect(c.tabs.sendMessage.mock.calls.map((args) => args[1].type)).toEqual([
    "ping",
  ]);
  expect(c.scripting.executeScript).not.toHaveBeenCalled();
  expect(c.runtime.openOptionsPage).not.toHaveBeenCalled();
});
it("an existing tab without a page bridge is injected and queried", async () => {
  const c = api();
  c.tabs.sendMessage.mockResolvedValueOnce(undefined);
  await ensurePageBridge(tab.id!);
  expect(c.scripting.executeScript).toHaveBeenCalledOnce();
  expect(c.tabs.sendMessage.mock.calls.map((args) => args[1].type)).toEqual([
    "ping",
    "ping",
  ]);
  expect(c.runtime.openOptionsPage).not.toHaveBeenCalled();
});
it("site access failure propagates to the panel without redirecting", async () => {
  const c = api();
  vi.spyOn(console, "error").mockImplementation(() => {});
  c.tabs.sendMessage.mockRejectedValue(Error("No receiver"));
  c.scripting.executeScript.mockRejectedValue(Error("Site access denied"));
  await expect(ensurePageBridge(tab.id!)).rejects.toThrow("Site access denied");
  expect(c.runtime.openOptionsPage).not.toHaveBeenCalled();
});
