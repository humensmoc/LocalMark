import { videoTarget } from "./video-transcript";

// Runs before the website in MAIN. Observe copies of the website's responses;
// never replace a response, change a request, or send credentials elsewhere.
export function observeNativeSubtitles() {
  const w = window as any;
  if (w.__localmarkNativeSubtitles) return;
  const state = (w.__localmarkNativeSubtitles = {
    records: [] as any[],
    revision: 0,
    domKey: "",
    openedKey: "",
    openedByLocalMarkKey: "",
  });
  const notify = () => {
    state.revision++;
    document.dispatchEvent(new Event("localmark-native-subtitles"));
  };
  function kind(address: string) {
    try {
      const u = new URL(address, location.href);
      if (
        u.hostname === "api.bilibili.com" &&
        /^\/x\/player\/(?:wbi\/)?v2$/.test(u.pathname)
      )
        return "bili-player";
      if (
        (u.hostname.endsWith(".hdslb.com") ||
          u.hostname.endsWith(".bilibili.com")) &&
        /subtitle/i.test(u.pathname)
      )
        return "bili-file";
      if (
        /^(www\.)?youtube\.com$/.test(u.hostname) &&
        (u.pathname === "/youtubei/v1/get_transcript" ||
          u.pathname === "/youtubei/v1/get_panel")
      )
        return "youtube";
      if (
        /^(www\.)?youtube\.com$/.test(u.hostname) &&
        u.pathname === "/api/timedtext"
      )
        return "youtube-player";
    } catch {
      /* Ignore unrelated/invalid URLs. */
    }
    return "";
  }
  function accept(
    address: string,
    key: string,
    data: any,
    status: number,
    requestOrder: number,
  ) {
    const type = kind(address);
    if (!type || !key || videoTarget(location.href)?.key !== key) return;
    // get_panel also serves non-transcript panels; keep only the modern
    // "转写文稿" panel so it never replaces an earlier transcript record.
    if (
      address.includes("/youtubei/v1/get_panel") &&
      !(typeof data === "object" && JSON.stringify(data).includes("transcriptSegmentViewModel"))
    )
      return;
    // Only subtitle metadata/text is retained, not unrelated player/user data.
    const value =
      type === "bili-player"
        ? {
            code: data.code,
            message: data.message,
            data: data.data && {
              bvid: data.data.bvid,
              aid: data.data.aid,
              cid: data.data.cid,
              page_no: data.data.page_no,
              subtitle: data.data.subtitle,
              need_login_subtitle: data.data.need_login_subtitle,
            },
          }
        : type === "bili-file"
          ? { body: data.body }
          : data;
    const previous = state.records.find(
      (r: any) => r.key === key && r.url === address,
    );
    if (previous && previous.order > requestOrder) return;
    const unchanged =
      previous &&
      previous.status === status &&
      JSON.stringify(previous.data) === JSON.stringify(value);
    const selectionChanged =
      state.records.filter((r: any) => r.key === key && r.type === type).at(-1)
        ?.url !== address;
    state.records = state.records.filter(
      (r: any) => !(r.key === key && r.url === address),
    );
    state.records.push({
      type,
      key,
      url: address,
      data: value,
      status,
      order: requestOrder,
    });
    state.records.sort((a: any, b: any) => a.order - b.order);
    state.records = state.records.slice(-24);
    if (type !== "youtube-player" && (!unchanged || selectionChanged)) notify();
  }
  let order = 0;
  const originalFetch = window.fetch;
  window.fetch = function (...args: Parameters<typeof fetch>) {
    const address = args[0] instanceof Request ? args[0].url : String(args[0]);
    const type = kind(address),
      key = videoTarget(location.href)?.key || "",
      requestOrder = ++order;
    const result = originalFetch.apply(this, args);
    if (type)
      void result
        .then((response) => {
          if (
            response.headers.get("content-length") &&
            Number(response.headers.get("content-length")) > 8_000_000
          )
            return;
          return response.clone().text().then((body) => {
            let data: any = body;
            try {
              data = JSON.parse(body);
            } catch { /* YouTube player subtitles may be XML timed-text. */ }
            accept(
              new URL(address, location.href).href,
              key,
              data,
              response.status,
              requestOrder,
            );
          });
        })
        .catch(() => {});
    return result;
  };
  const originalOpen = XMLHttpRequest.prototype.open,
    originalSend = XMLHttpRequest.prototype.send;
  const requests = new WeakMap<
    XMLHttpRequest,
    { url: string; key: string; order: number }
  >();
  XMLHttpRequest.prototype.open = function (...args: any[]) {
    requests.set(this, {
      url: new URL(String(args[1]), location.href).href,
      key: "",
      order: 0,
    });
    return (originalOpen as any).apply(this, args);
  };
  XMLHttpRequest.prototype.send = function (
    ...args: Parameters<XMLHttpRequest["send"]>
  ) {
    const request = requests.get(this);
    if (request && kind(request.url)) {
      request.key = videoTarget(location.href)?.key || "";
      request.order = ++order;
      const current = { ...request };
      this.addEventListener(
        "load",
        () => {
          try {
            accept(
              current.url,
              current.key,
              this.responseType === "json"
                ? this.response
                : (() => {
                    try {
                      return JSON.parse(this.responseText);
                    } catch {
                      return this.responseText;
                    }
                  })(),
              this.status,
              current.order,
            );
          } catch {
            /* Not subtitle JSON. */
          }
        },
        { once: true },
      );
    }
    return originalSend.apply(this, args);
  };
  if (location.hostname.endsWith("youtube.com")) {
    const transcript =
      "ytd-transcript-renderer,ytd-transcript-segment-renderer,transcript-segment-view-model";
    new MutationObserver((records) => {
      if (
        !records.some((r) => {
          const target =
            r.target instanceof Element ? r.target : r.target.parentElement;
          return (
            target?.closest(transcript) ||
            Array.from(r.addedNodes).some(
              (n) =>
                n instanceof Element &&
                (n.matches(transcript) || n.querySelector(transcript)),
            )
          );
        })
      )
        return;
      state.domKey = videoTarget(location.href)?.key || "";
      notify();
    }).observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  } else {
    new MutationObserver((records) => {
      if (
        records.some(
          (r) =>
            r.target instanceof Element &&
            r.target.closest(".bpx-player-ctrl-subtitle-menu"),
        )
      )
        notify();
    }).observe(document, {
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "aria-checked"],
    });
  }
}
observeNativeSubtitles();
