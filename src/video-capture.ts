export type CaptureRect = {
  left: number;
  top: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
};

// Hide player chrome for the single frame captured by captureVisibleTab. The
// pause happens in the content script before this function runs.
const PLAYER_CONTROLS = `
video::-webkit-media-controls { display: none !important; }
#movie_player .ytp-chrome-bottom, #movie_player .ytp-chrome-top,
#movie_player .ytp-gradient-bottom, #movie_player .ytp-gradient-top,
#movie_player .ytp-tooltip, #movie_player .ytp-bezel,
#movie_player .ytp-caption-window-container, #movie_player .ytp-pause-overlay,
#movie_player .ytp-cards-teaser, #movie_player .ytp-ce-element,
.bpx-player-control-wrap, .bpx-player-top-wrap, .bpx-player-toast-wrap,
.bpx-player-dm-wrap, .bpx-player-subtitle, .bpx-player-ending-panel,
.bpx-player-pause-panel, .bpx-player-state-wrap,
.vjs-control-bar, .vjs-big-play-button, .vjs-loading-spinner,
.vjs-text-track-display { visibility: hidden !important; }
`;

export async function captureVideoImage(sender: chrome.runtime.MessageSender, rect: CaptureRect): Promise<Blob> {
  if (!sender.tab?.id || sender.frameId !== 0 || typeof sender.tab.windowId !== "number")
    throw Error("只能从当前视频页面截图。");
  const [active] = await chrome.tabs.query({ active: true, windowId: sender.tab.windowId });
  if (active?.id !== sender.tab.id) throw Error("请先切换到当前视频标签页再截图。");
  const numbers = Object.values(rect);
  if (numbers.some(value => !Number.isFinite(value)) || rect.width < 24 || rect.height < 24 ||
      rect.viewportWidth < 100 || rect.viewportHeight < 100 || rect.left < 0 || rect.top < 0 ||
      rect.left + rect.width > rect.viewportWidth + 1 || rect.top + rect.height > rect.viewportHeight + 1)
    throw Error("视频画面没有完整显示在窗口中，请滚动到播放器后重试。");
  const target = { tabId: sender.tab.id, allFrames: true };
  await chrome.scripting.insertCSS({ target, css: PLAYER_CONTROLS });
  let dataUrl: string;
  try {
    await new Promise(resolve => setTimeout(resolve, 80));
    dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" });
  } finally {
    await chrome.scripting.removeCSS({ target, css: PLAYER_CONTROLS });
  }
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  try {
    const sx = bitmap.width / rect.viewportWidth, sy = bitmap.height / rect.viewportHeight;
    const x = Math.round(rect.left * sx), y = Math.round(rect.top * sy);
    const width = Math.min(bitmap.width - x, Math.round(rect.width * sx));
    const height = Math.min(bitmap.height - y, Math.round(rect.height * sy));
    if (width < 24 || height < 24) throw Error("截图区域无效，请重新打开播放器后重试。");
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext("2d")!.drawImage(bitmap, x, y, width, height, 0, 0, width, height);
    return await canvas.convertToBlob({ type: "image/png" });
  } finally { bitmap.close(); }
}

export async function imagePreview(blob: Blob): Promise<string> {
  const image = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, 960 / image.width, 540 / image.height);
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
    canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
    const thumb = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.86 });
    const bytes = new Uint8Array(await thumb.arrayBuffer());
    let binary = "";
    for (let at = 0; at < bytes.length; at += 8192)
      binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
    return `data:image/jpeg;base64,${btoa(binary)}`;
  } finally { image.close(); }
}
