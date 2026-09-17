export type PageInfo = {
  ready: true;
  url: string;
  title: string;
  favicon: string;
  version: string;
  located: string[];
};

export type PageAction = {
  type: "page-action";
  action: "jump" | "edit" | "rebind";
  url: string;
  id: string;
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
