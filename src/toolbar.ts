import type { PageInfo } from "./page-bridge";
async function ping(tabId: number): Promise<PageInfo> {
  const response = await chrome.tabs.sendMessage(
    tabId,
    { type: "ping" },
    { frameId: 0 },
  );
  if (!response?.ready || !response.url) throw Error("网页标注界面尚未就绪");
  return response;
}
// Bootstrap tabs that predate installation/reload without a toolbar click.
export async function ensurePageBridge(tabId: number): Promise<PageInfo> {
  try {
    return await ping(tabId);
  } catch {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["highlights.css"],
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        return await ping(tabId);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw Error("网页标注界面连接失败，请刷新网页，并检查插件的网站访问权限。");
  }
}
