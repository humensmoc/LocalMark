// Deadlines cover the extension channel and script injection, not just fetch.
// A late result is still observed by Promise.race but cannot replace its timeout.
export async function transcriptDeadline<T>(
  pending: Promise<T>,
  milliseconds: number,
  reason: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(reason)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function transcriptMessage<T = any>(
  message: object,
  milliseconds: number,
  reason: string,
): Promise<T> {
  try {
    return await transcriptDeadline(
      chrome.runtime.sendMessage(message),
      milliseconds,
      reason,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (
      /context invalidated|Receiving end does not exist|message port closed|message channel closed/i.test(
        message,
      )
    )
      throw Error("字幕扩展连接已断开，请重新加载 LocalMark 扩展并刷新网页。");
    throw e;
  }
}
