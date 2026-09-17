import { afterEach, expect, it, vi } from "vitest";
import { handleToolbarClick } from "../src/toolbar";

function api() {
  const chrome = {
    tabs: { sendMessage: vi.fn().mockResolvedValue({ ready: true }) },
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

it("toolbar toggles a ready content script and does not open options", async () => {
  const c = api();
  await handleToolbarClick(tab);
  expect(c.tabs.sendMessage.mock.calls.map((args) => args[1].type)).toEqual([
    "ping",
    "toggle",
  ]);
  expect(c.scripting.executeScript).not.toHaveBeenCalled();
  expect(c.runtime.openOptionsPage).not.toHaveBeenCalled();
});
it("missing readiness acknowledgement reinjects and opens explicitly", async () => {
  const c = api();
  c.tabs.sendMessage.mockResolvedValueOnce(undefined);
  await handleToolbarClick(tab);
  expect(c.scripting.executeScript).toHaveBeenCalledOnce();
  expect(c.tabs.sendMessage.mock.calls.map((args) => args[1].type)).toEqual([
    "ping",
    "show",
  ]);
  expect(c.runtime.openOptionsPage).not.toHaveBeenCalled();
});
it("injection failure on a website reports the error without redirecting to options", async () => {
  const c = api();
  vi.spyOn(console, "error").mockImplementation(() => {});
  c.tabs.sendMessage.mockRejectedValue(Error("No receiver"));
  c.scripting.executeScript.mockRejectedValue(Error("Site access denied"));
  await handleToolbarClick(tab);
  expect(c.runtime.openOptionsPage).not.toHaveBeenCalled();
  expect(c.action.setBadgeText).toHaveBeenCalledWith({ tabId: 7, text: "!" });
  expect(c.action.setTitle.mock.calls[0][0].title).toContain(
    "Site access denied",
  );
});
