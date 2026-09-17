import { afterEach, expect, it, vi } from "vitest";
import { closeSidePanel } from "../src/page-bridge";

afterEach(() => vi.unstubAllGlobals());

it("Chrome 128 closes its native panel document without calling a missing API", async () => {
  const close = vi.fn();
  vi.stubGlobal("chrome", { sidePanel: {} });
  vi.stubGlobal("window", { close });
  await closeSidePanel(7);
  expect(close).toHaveBeenCalledOnce();
});

it("new Chrome closes only the requested window's panel", async () => {
  const close = vi.fn().mockResolvedValue(undefined), documentClose = vi.fn();
  vi.stubGlobal("chrome", { sidePanel: { close } });
  vi.stubGlobal("window", { close: documentClose });
  await closeSidePanel(7);
  expect(close).toHaveBeenCalledWith({ windowId: 7 });
  expect(documentClose).not.toHaveBeenCalled();
});

it("a supported API failure remains visible to the caller", async () => {
  vi.stubGlobal("chrome", { sidePanel: { close: vi.fn().mockRejectedValue(Error("Window closed")) } });
  const close = vi.fn();
  vi.stubGlobal("window", { close });
  await expect(closeSidePanel(7)).rejects.toThrow("Window closed");
  expect(close).not.toHaveBeenCalled();
});
