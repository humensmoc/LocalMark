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
  it("only fetches a selected file URL from verified current-player metadata", async () => {
    bili();
    const fetch = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        json: async () => ({ body: [{ from: 1, to: 3, content: "Chinese" }] }),
      });
    vi.stubGlobal("fetch", fetch);
    expect(await readVideoTranscript("bilibili:BVtest:2", "zh")).toMatchObject({
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
