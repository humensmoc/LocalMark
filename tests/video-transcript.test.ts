import { afterEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import {
  readVideoTranscript,
  transcriptRequest,
  subtitleTime,
  videoTarget,
} from "../src/video-transcript";
function page(url = "https://www.youtube.com/watch?v=first") {
  const d = new JSDOM(
    '<ytd-watch-flexy video-id="first"><div id="movie_player"></div></ytd-watch-flexy>',
    { url },
  );
  vi.stubGlobal("window", d.window);
  vi.stubGlobal("document", d.window.document);
  vi.stubGlobal("location", d.window.location);
  return d.window as any;
}
function youtube(w: any) {
  w.ytInitialPlayerResponse = {
    videoDetails: { videoId: "first" },
    playabilityStatus: { status: "OK" },
  };
  w.ytInitialData = { getTranscriptEndpoint: { params: "first-params" } };
  w.ytcfg = {
    get: (n: string) =>
      n === "INNERTUBE_CONTEXT"
        ? { client: { clientVersion: "test" } }
        : undefined,
  };
}
const segment = (startMs: string, content: string) => ({
  transcriptSegmentRenderer: {
    startMs,
    endMs: "6000",
    snippet: { runs: [{ text: content }] },
  },
});
afterEach(() => {
  vi.unstubAllGlobals();
});
describe("video transcript sources", () => {
  it("allows SPA requests with the document's old sender URL and targets that document", async () => {
    const executeScript = vi
      .fn()
      .mockResolvedValue([{ result: { key: "bilibili:BVtest:2", cues: [] } }]);
    vi.stubGlobal("chrome", {
      runtime: { id: "localmark" },
      scripting: { executeScript },
    });
    const result = await transcriptRequest(
      { key: "bilibili:BVtest:2" },
      {
        id: "localmark",
        frameId: 0,
        documentId: "doc",
        url: "https://www.bilibili.com/video/BVtest/",
        tab: { id: 123 } as chrome.tabs.Tab,
      },
    );
    expect(result.key).toBe("bilibili:BVtest:2");
    expect(executeScript.mock.calls[0][0].target).toEqual({
      tabId: 123,
      documentIds: ["doc"],
    });
  });
  it("routes the internal YouTube player download without exposing a language selection", async () => {
    const executeScript = vi.fn().mockResolvedValue([{ result: {
      key: "youtube:first", source: "YouTube · 播放器字幕", tracks: [], selected: "player:en",
      cues: [{ start: 1, end: 2, text: "player wording" }],
    } }]);
    vi.stubGlobal("chrome", { runtime: { id: "localmark" }, scripting: { executeScript } });
    const sender = { id: "localmark", frameId: 0, documentId: "top", tab: { id: 7 },
      url: "https://www.youtube.com/watch?v=first" } as chrome.runtime.MessageSender;
    expect(await transcriptRequest({ key: "youtube:first", source: "player" }, sender))
      .toHaveProperty("source", "YouTube · 播放器字幕");
    expect(executeScript.mock.calls[0][0].args).toEqual(["youtube:first", false, "player"]);
    await expect(transcriptRequest({ key: "bilibili:BVtest:1", source: "player" }, sender))
      .rejects.toThrow("只能读取当前 YouTube");
  });
  it("does not inject the reader for other origins or frames", async () => {
    const executeScript = vi.fn();
    vi.stubGlobal("chrome", {
      runtime: { id: "localmark" },
      scripting: { executeScript },
    });
    for (const [url, frameId] of [
      ["https://www.youtube.com.evil.test/", 0],
      ["https://www.youtube.com/watch?v=first", 2],
    ] as const)
      await expect(
        transcriptRequest(
          { key: "youtube:first" },
          {
            id: "localmark",
            frameId,
            url,
            tab: { id: 123 } as chrome.tabs.Tab,
          },
        ),
      ).rejects.toThrow("只能读取");
    expect(executeScript).not.toHaveBeenCalled();
  });
  it("limits activation to video routes and keys Bilibili parts independently", () => {
    expect(videoTarget("https://www.youtube.com/watch?v=abc&t=3")).toEqual({
      site: "youtube",
      key: "youtube:abc",
    });
    expect(videoTarget("https://www.bilibili.com/video/BVabc/?p=2")).toEqual({
      site: "bilibili",
      key: "bilibili:BVabc:2",
    });
    expect(videoTarget("https://youtube.com.evil.test/watch?v=a")).toBeNull();
    expect(videoTarget("https://www.bilibili.com/")).toBeNull();
  });
  it("formats long videos without wrapping hours", () => {
    expect(subtitleTime(29.8)).toBe("0:29");
    expect(subtitleTime(3661.9)).toBe("1:01:01");
  });
  it("reads the full YouTube response produced by the website without fetching", async () => {
    const w = page();
    youtube(w);
    w.__localmarkNativeSubtitles = {
      records: [
        {
          type: "youtube",
          key: "youtube:first",
          status: 200,
          data: {
            items: [segment("3000", "native response")],
            footer: {
              title: "English",
              selected: true,
              continuation: { reloadContinuationData: { continuation: "en" } },
            },
          },
        },
      ],
    };
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await readVideoTranscript("youtube:first")).toMatchObject({
      cues: [{ start: 3, text: "native response" }],
      selected: "en",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("reads an already displayed native panel even when the independent API failed", async () => {
    const w = page();
    youtube(w);
    w.__localmarkNativeSubtitles = {
      domKey: "youtube:first",
      records: [
        {
          type: "youtube",
          key: "youtube:first",
          status: 400,
          data: { error: { message: "Precondition check failed" } },
        },
      ],
    };
    w.document.body.insertAdjacentHTML(
      "beforeend",
      '<ytd-transcript-renderer><ytd-transcript-segment-renderer><span class="segment-timestamp">1:02</span><span class="segment-text">native DOM</span></ytd-transcript-segment-renderer></ytd-transcript-renderer>',
    );
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await readVideoTranscript("youtube:first")).toMatchObject({
      cues: [{ start: 62, text: "native DOM" }],
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("supports the newer native transcript segment model", async () => {
    const w = page();
    youtube(w);
    w.__localmarkNativeSubtitles = { domKey: "youtube:first", records: [] };
    w.document.body.insertAdjacentHTML(
      "beforeend",
      '<ytd-transcript-renderer><transcript-segment-view-model><span class="ytwTranscriptSegmentViewModelTimestamp">0:42</span><span class="ytwTranscriptSegmentViewModelText">new DOM</span></transcript-segment-view-model></ytd-transcript-renderer>',
    );
    expect(await readVideoTranscript("youtube:first")).toMatchObject({
      cues: [{ start: 42, text: "new DOM" }],
    });
  });
  it("reads the modern get_panel transcript with timestamp-only segments", async () => {
    const w = page();
    youtube(w);
    const item = (timestamp: string, simpleText: string) => ({
      macroMarkersPanelItemViewModel: { item: { timelineItemViewModel: {
        timestamp, contentItems: [{ transcriptSegmentViewModel: { simpleText, timestamp } }],
      } } },
    });
    w.__localmarkNativeSubtitles = { records: [{ type: "youtube", key: "youtube:first", status: 200,
      data: { content: { engagementPanelSectionListRenderer: { content: { sectionListRenderer: {
        contents: [{ itemSectionRenderer: { contents: [item("0:12", "hi"), item("1:02", "later")] } }],
      } } } } } }] };
    expect(await readVideoTranscript("youtube:first")).toMatchObject({
      source: "YouTube · 原生内容转文字",
      cues: [{ start: 12, end: 62, text: "hi" }, { start: 62, end: 65, text: "later" }],
    });
  });
  it("reads the expanded modern transcript panel DOM instead of a hidden legacy panel", async () => {
    const w = page();
    youtube(w);
    w.__localmarkNativeSubtitles = { domKey: "youtube:first", records: [] };
    w.document.body.insertAdjacentHTML(
      "beforeend",
      '<ytd-engagement-panel-section-list-renderer target-id="engagement-panel-searchable-transcript" visibility="ENGAGEMENT_PANEL_VISIBILITY_HIDDEN"></ytd-engagement-panel-section-list-renderer>' +
        '<ytd-engagement-panel-section-list-renderer target-id="PAmodern_transcript_view" visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED">' +
        '<transcript-segment-view-model><div class="ytwTranscriptSegmentViewModelTimestamp">0:12</div><div class="ytwTranscriptSegmentViewModelTimestampA11yLabel">12秒钟</div><span class="ytAttributedStringHost">modern DOM</span></transcript-segment-view-model>' +
        "</ytd-engagement-panel-section-list-renderer>",
    );
    expect(await readVideoTranscript("youtube:first")).toMatchObject({
      cues: [{ start: 12, text: "modern DOM" }],
    });
  });
  it("opens the website transcript button once instead of reconstructing API calls", async () => {
    const w = page();
    youtube(w);
    w.__localmarkNativeSubtitles = { records: [], openedKey: "" };
    w.document.body.insertAdjacentHTML(
      "beforeend",
      "<ytd-video-description-transcript-section-renderer><button>内容转文字</button></ytd-video-description-transcript-section-renderer>",
    );
    const click = vi.fn(),
      fetch = vi.fn();
    w.document.querySelector("button").addEventListener("click", click);
    vi.stubGlobal("fetch", fetch);
    await readVideoTranscript("youtube:first");
    await readVideoTranscript("youtube:first");
    expect(click).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("closes the native transcript panel after the plugin opened it", async () => {
    const w = page();
    youtube(w);
    w.__localmarkNativeSubtitles = { records: [], openedKey: "", openedByLocalMarkKey: "" };
    const section = w.document.createElement("ytd-video-description-transcript-section-renderer");
    const open = w.document.createElement("button");
    open.textContent = "内容转文字";
    section.append(open);
    w.document.body.append(section);
    const panel = w.document.createElement("ytd-engagement-panel-section-list-renderer");
    panel.setAttribute("target-id", "engagement-panel-searchable-transcript");
    const close = w.document.createElement("button");
    close.setAttribute("aria-label", "关闭");
    let closed = 0;
    close.addEventListener("click", () => closed++);
    panel.append(close);
    w.document.body.append(panel);
    await readVideoTranscript("youtube:first");
    w.__localmarkNativeSubtitles.records = [{
      type: "youtube", key: "youtube:first", status: 200,
      data: { items: [segment("1000", "native response")] },
    }];
    await readVideoTranscript("youtube:first");
    expect(closed).toBe(1);
    expect(w.__localmarkNativeSubtitles.openedByLocalMarkKey).toBe("");
  });
  it("uses native YouTube transcript even when the player advertises a separate caption track", async () => {
    const w = page();
    youtube(w);
    w.__localmarkNativeSubtitles = { records: [], openedKey: "" };
    const player = w.document.querySelector("#movie_player") as any;
    player.getPlayerResponse = () => ({
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{
            languageCode: "en",
            name: { simpleText: "English" },
            baseUrl: "https://www.youtube.com/api/timedtext?v=first&lang=en",
          }],
        },
      },
    });
    w.__localmarkNativeSubtitles.records = [{ type: "youtube", key: "youtube:first", status: 200,
      data: { items: [segment("1000", "native wording")] } }];
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const result = await readVideoTranscript("youtube:first");
    expect(result).toMatchObject({
      source: "YouTube · 原生内容转文字",
      cues: [{ start: 1, text: "native wording" }],
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("reads the player's JSON3 captions separately for download without changing the native source", async () => {
    const w = page();
    youtube(w);
    w.__localmarkNativeSubtitles = { records: [{ type: "youtube", key: "youtube:first", status: 200,
      data: { items: [segment("1000", "native wording")] } }] };
    const player = w.document.querySelector("#movie_player") as any;
    player.getPlayerResponse = () => ({ captions: { playerCaptionsTracklistRenderer: { captionTracks: [{
      languageCode: "en", name: { simpleText: "English" },
      baseUrl: "https://www.youtube.com/api/timedtext?v=first&lang=en",
    }] } } });
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200,
      text: async () => JSON.stringify({ events: [{ tStartMs: 1000, dDurationMs: 2500,
        segs: [{ utf8: "player wording" }] }] }) });
    vi.stubGlobal("fetch", fetch);
    expect(await readVideoTranscript("youtube:first", false, "player")).toMatchObject({
      source: "YouTube · 播放器字幕",
      cues: [{ start: 1, end: 3.5, text: "player wording" }],
    });
    expect(await readVideoTranscript("youtube:first")).toMatchObject({
      source: "YouTube · 原生内容转文字",
      cues: [{ text: "native wording" }],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("uses captured player XML captions when direct timed-text fetch is unavailable", async () => {
    const w = page();
    youtube(w);
    w.__localmarkNativeSubtitles = { records: [{
      type: "youtube-player", key: "youtube:first", status: 200,
      url: "https://www.youtube.com/api/timedtext?v=first&lang=en",
      data: '<transcript><text start="2" dur="3">now &amp; permanent</text></transcript>',
    }] };
    const player = w.document.querySelector("#movie_player") as any;
    player.getPlayerResponse = () => ({ captions: { playerCaptionsTracklistRenderer: { captionTracks: [{
      languageCode: "en", name: { simpleText: "English" },
      baseUrl: "https://www.youtube.com/api/timedtext?v=first&lang=en",
    }] } } });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await readVideoTranscript("youtube:first", false, "player")).toMatchObject({
      cues: [{ start: 2, end: 5, text: "now & permanent" }],
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not expose player source choices when the native transcript is not ready", async () => {
    const w = page();
    youtube(w);
    w.__localmarkNativeSubtitles = { records: [], openedKey: "" };
    const player = w.document.querySelector("#movie_player") as any;
    player.getPlayerResponse = () => ({
      captions: { playerCaptionsTracklistRenderer: { captionTracks: [{
        languageCode: "en",
        name: { simpleText: "English" },
        baseUrl: "https://www.youtube.com/api/timedtext?v=first&lang=en",
      }] } },
    });
    expect(await readVideoTranscript("youtube:first")).toEqual({ error: expect.any(String) });
  });
  it("rejects native records and DOM from the previous video", async () => {
    const w = page("https://www.youtube.com/watch?v=second");
    youtube(w);
    w.document
      .querySelector("ytd-watch-flexy")
      .setAttribute("video-id", "second");
    w.__localmarkNativeSubtitles = {
      domKey: "youtube:first",
      records: [
        {
          type: "youtube",
          key: "youtube:first",
          status: 200,
          data: { items: [segment("0", "OLD")] },
        },
      ],
    };
    w.document.body.insertAdjacentHTML(
      "beforeend",
      '<ytd-transcript-renderer><ytd-transcript-segment-renderer><span class="segment-timestamp">0:01</span><span class="segment-text">OLD</span></ytd-transcript-segment-renderer></ytd-transcript-renderer>',
    );
    expect(await readVideoTranscript("youtube:second")).toMatchObject({
      error: expect.stringContaining("内容转文字"),
    });
    expect(await readVideoTranscript("youtube:first")).toMatchObject({
      error: expect.stringContaining("视频已切换"),
    });
  });
  function bili() {
    const w = page("https://www.bilibili.com/video/BVtest/?p=2");
    w.__INITIAL_STATE__ = {
      videoData: {
        bvid: "BVtest",
        aid: 123,
        title: "Current video",
        pages: [{ page: 2, cid: 22 }],
      },
    };
    w.__localmarkNativeSubtitles = {
      records: [
        {
          type: "bili-player",
          key: "bilibili:BVtest:2",
          url: "https://api.bilibili.com/x/player/wbi/v2?bvid=BVtest&cid=22",
          status: 200,
          data: {
            code: 0,
            data: {
              bvid: "BVtest",
              aid: 123,
              cid: 22,
              page_no: 2,
              subtitle: {
                subtitles: [
                  {
                    id_str: "zh",
                    lan: "zh-CN",
                    lan_doc: "中文",
                    subtitle_url:
                      "https://aisubtitle.hdslb.com/subtitle/zh.json",
                  },
                  {
                    id_str: "en",
                    lan: "en",
                    lan_doc: "English",
                    subtitle_url:
                      "https://aisubtitle.hdslb.com/subtitle/en.json",
                  },
                ],
              },
            },
          },
        },
        {
          type: "bili-file",
          key: "bilibili:BVtest:2",
          url: "https://aisubtitle.hdslb.com/subtitle/en.json",
          status: 200,
          data: {
            body: [{ from: 2, to: 5, content: "Actual player English" }],
          },
        },
      ],
    };
    return w;
  }
  it("uses Bilibili's actual loaded language instead of always defaulting to Chinese", async () => {
    bili();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await readVideoTranscript("bilibili:BVtest:2")).toMatchObject({
      selected: "en",
      cues: [{ start: 2, text: "Actual player English" }],
      details: expect.stringContaining("CID 22"),
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("only fetches the default file URL from verified current-player metadata", async () => {
    const w = bili();
    w.__localmarkNativeSubtitles.records = w.__localmarkNativeSubtitles.records.filter((r: any) => r.type !== "bili-file");
    const fetch = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        json: async () => ({ body: [{ from: 1, to: 3, content: "Chinese" }] }),
      });
    vi.stubGlobal("fetch", fetch);
    expect(await readVideoTranscript("bilibili:BVtest:2")).toMatchObject({
      selected: "zh",
      cues: [{ text: "Chinese" }],
    });
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([
      "https://aisubtitle.hdslb.com/subtitle/zh.json",
    ]);
  });
  it("refuses unrelated BVID, CID and mismatched request/response identities", async () => {
    for (const mutation of [
      (w: any) =>
        (w.__localmarkNativeSubtitles.records[0].data.data.bvid = "BVother"),
      (w: any) => (w.__localmarkNativeSubtitles.records[0].data.data.cid = 99),
      (w: any) => (w.__localmarkNativeSubtitles.records[0].url += "&aid=999"),
    ]) {
      const w = bili();
      mutation(w);
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      expect(await readVideoTranscript("bilibili:BVtest:2")).toMatchObject({
        error: expect.stringContaining("已拒绝"),
      });
      expect(fetch).not.toHaveBeenCalled();
    }
  });
  it("never falls back to the independent unsigned Bilibili metadata endpoint", async () => {
    const w = bili();
    w.__localmarkNativeSubtitles.records = [];
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await readVideoTranscript("bilibili:BVtest:2")).toMatchObject({
      error: expect.stringContaining("等待当前播放器"),
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("reports the actual player's login restriction", async () => {
    const w = bili(),
      d = w.__localmarkNativeSubtitles.records[0].data.data;
    d.subtitle.subtitles = [];
    d.need_login_subtitle = true;
    expect(await readVideoTranscript("bilibili:BVtest:2")).toMatchObject({
      error: expect.stringContaining("需要登录"),
    });
  });
});
