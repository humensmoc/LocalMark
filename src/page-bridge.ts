export const SIDEBAR_PRESENCE_PORT = "localmark-sidebar-presence";

export function openSidePanelFromPage(sender: chrome.runtime.MessageSender) {
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 ||
      typeof sender.tab?.windowId !== "number" || !/^https?:\/\//.test(sender.url ?? ""))
    throw Error("只能从当前网页打开侧边栏。");
  return chrome.sidePanel.open({ windowId: sender.tab.windowId });
}

export function isSidebarPresence(port: Pick<chrome.runtime.Port, "name" | "sender">) {
  const sender = port.sender;
  if (port.name !== SIDEBAR_PRESENCE_PORT || sender?.id !== chrome.runtime.id) return false;
  if (sender.url) return sender.url === chrome.runtime.getURL("sidepanel.html");
  // Chrome 128 omits sender.url for native side-panel ports, but includes origin.
  return !sender.tab && sender.origin === chrome.runtime.getURL("").replace(/\/$/, "");
}

export type PageInfo = {
  ready: true;
  url: string;
  title: string;
  favicon: string;
  version: string;
  located: string[];
  approximate?: string[];
  excerpts?: Record<string, string>;
  picking?: boolean;
};

export type PageAction = {
  type: "page-action";
  action: "jump" | "edit" | "rebind" | "pick-element" | "cancel-pick";
  url: string;
  id?: string;
};

// This is called only from the native side-panel document. Chrome 128 supports
// closing that document with window.close(); sidePanel.close arrived in 141.
export async function closeSidePanel(windowId: number) {
  const panel = chrome.sidePanel as typeof chrome.sidePanel & {
    close?: (options: { windowId: number }) => Promise<void>;
  };
  if (typeof panel.close === "function") await panel.close({ windowId });
  else window.close();
}
