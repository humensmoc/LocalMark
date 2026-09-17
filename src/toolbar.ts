async function send(tabId: number, type: "ping" | "toggle" | "show") {
  const response = await chrome.tabs.sendMessage(
    tabId,
    { type },
    { frameId: 0 },
  );
  if (!response?.ready) throw Error("网页标注界面尚未就绪");
}

export async function handleToolbarClick(tab: chrome.tabs.Tab) {
  if (!tab.id) return;
  const tabId = tab.id;
  try {
    try {
      await send(tabId, "ping");
      await send(tabId, "toggle");
    } catch {
      if (tab.url && !/^https?:\/\//.test(tab.url)) {
        await chrome.runtime.openOptionsPage();
        return;
      }
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ["highlights.css"],
      });
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"],
      });
      // executeScript completes before React's effect installs the message listener.
      let ready = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          await send(tabId, "show");
          ready = true;
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      if (!ready) throw Error("网页标注界面连接失败，请刷新当前网页后重试");
    }
    await chrome.action.setBadgeText({ tabId, text: "" });
    await chrome.action.setTitle({ tabId, title: "打开 / 收起本地摘录" });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("本地摘录：无法打开网页侧栏", message);
    await chrome.action.setBadgeText({ tabId, text: "!" });
    await chrome.action.setTitle({
      tabId,
      title: `无法打开侧栏：${message}。请刷新网页，并检查插件的网站访问权限。`,
    });
  }
}
