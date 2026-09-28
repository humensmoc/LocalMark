import { afterEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import {
  gdcPageContext,
  gdcPlayerAction,
  gdcSubtitleSegments,
  gdcSubtitleTracks,
  gdcSubtitleUrl,
  mergeGdcVtt,
  parseGdcVtt,
  gdcTranscriptRequest,
  gdcPlaybackRequest,
} from "../src/gdc-transcript";
import { videoTarget } from "../src/video-transcript";
const base = "https://cdn-a.blazestreaming.com/course/index.m3u8";
const vtt = (
  text = "Hello &amp; <i>世界</i>",
  time = "00:00:10.000 --> 00:00:12.500",
  map = "LOCAL:00:00:00.000,MPEGTS:180000",
) =>
  `WEBVTT\nX-TIMESTAMP-MAP=${map}\n\ncue-1\n${time} align:start\n${text}\n\n`;
afterEach(() => {
  vi.unstubAllGlobals();
});
function dom(url: string, markup: string) {
  const w = new JSDOM(markup, { url }).window;
  vi.stubGlobal("window", w);
  vi.stubGlobal("document", w.document);
  vi.stubGlobal("location", w.location);
  return w;
}
describe("GDC Vault subtitles", () => {
  it("keys only the actual session page", () => {
    expect(videoTarget("https://gdcvault.com/play/1034161/Game-Art")).toEqual({
      site: "gdcvault",
      key: "gdcvault:1034161",
    });
    expect(videoTarget("https://www.gdcvault.com/browse")).toBeNull();
    expect(
      videoTarget("https://gdcvault.com.evil.test/play/1034161"),
    ).toBeNull();
  });
  it("reads only subtitle renditions, with relative URLs and quoted commas", () => {
    const tracks = gdcSubtitleTracks(
      '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio.m3u8"\n#EXT-X-MEDIA:TYPE=SUBTITLES,NAME="English, CC",LANGUAGE="eng",DEFAULT=YES,URI="../en.m3u8"\n#EXT-X-MEDIA:TYPE=SUBTITLES,NAME="Chinese",LANGUAGE="zho",URI="zh.m3u8"',
      base,
    );
    expect(tracks).toHaveLength(2);
    expect(tracks[0]).toMatchObject({
      id: "https://cdn-a.blazestreaming.com/en.m3u8",
      label: "English, CC",
      default: true,
    });
    expect(tracks[1].label).toBe("Chinese (Simplified)");
    expect(() =>
      gdcSubtitleUrl("https://blazestreaming.com.evil.test/a.vtt"),
    ).toThrow();
    expect(() => gdcSubtitleUrl("http://127.0.0.1/private")).toThrow();
  });
  it("requires complete supported subtitle playlists and preserves segment order", () => {
    expect(
      gdcSubtitleSegments(
        "#EXTM3U\n#EXTINF:6,\na.vtt\n#EXTINF:6,\nb.vtt\n#EXT-X-ENDLIST",
        base,
      ),
    ).toEqual([
      "https://cdn-a.blazestreaming.com/course/a.vtt",
      "https://cdn-a.blazestreaming.com/course/b.vtt",
    ]);
    expect(() => gdcSubtitleSegments("#EXTM3U\na.vtt", base)).toThrow("未完成");
    expect(() =>
      gdcSubtitleSegments(
        "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128\na.vtt\n#EXT-X-ENDLIST",
        base,
      ),
    ).toThrow("加密");
  });
  it("parses cue IDs, timing settings, multiline text and literal entity text", () => {
    expect(
      parseGdcVtt(
        "\uFEFF" +
          vtt(
            "<v Alice>Hello &amp; 世界</v>\n&lt;img src=x&gt;\n<00:00:11.000>next",
          ),
      ).cues,
    ).toEqual([
      { start: 10, end: 12.5, text: "Hello & 世界\n<img src=x>\nnext" },
    ]);
    expect(
      parseGdcVtt(
        "WEBVTT\n\nNOTE ignore\ntext\n\nSTYLE\n::cue { color: red; }\n\n",
      ).cues,
    ).toEqual([]);
    expect(() => parseGdcVtt("<html>login</html>")).toThrow("WebVTT");
  });
  it("deduplicates boundary cues and keeps different text at the same time", () => {
    const cues = mergeGdcVtt([
      vtt(),
      vtt() + "other\n00:00:10.000 --> 00:00:12.500\nAnother speaker\n\n",
    ]);
    expect(cues).toHaveLength(2);
    expect(cues[0].start).toBe(10);
  });
  it("maps local segment clocks to VOD time without the MPEGTS start offset", () => {
    expect(
      mergeGdcVtt([
        vtt("a"),
        vtt(
          "b",
          "00:00:01.000 --> 00:00:02.000",
          "LOCAL:00:00:00.000,MPEGTS:1080000",
        ),
      ]).map((c) => c.start),
    ).toEqual([10, 11]);
  });
  it("validates the top page and limits discovery to its embedded player", () => {
    dom(
      "https://gdcvault.com/play/123/Talk",
      '<div id="player"><div id="container"><iframe src="https://gdcvault.blazestreaming.com/?id=course"></iframe></div></div>',
    );
    expect(gdcPageContext("gdcvault:123")).toEqual({
      frameUrl: "https://gdcvault.blazestreaming.com/?id=course",
    });
    expect(gdcPageContext("gdcvault:456").error).toMatch("切换");
    document.querySelector("iframe")!.src = "https://unrelated.test";
    expect(gdcPageContext("gdcvault:123").error).toMatch("未支持");
  });
  it("ignores unrelated frames and rejects stale media and out-of-range seeks", () => {
    dom("https://gdcvault.blazestreaming.com/?id=course", "<video></video>");
    const video = document.querySelector("video")!;
    Object.defineProperties(video, {
      currentSrc: { value: base },
      readyState: { value: 4 },
      duration: { value: 60 },
    });
    expect(
      gdcPlayerAction(
        "https://gdcvault.blazestreaming.com/?id=other",
        "describe",
      ),
    ).toBeNull();
    expect(
      gdcPlayerAction(location.href, "seek", "old-source", 10),
    ).toHaveProperty("error");
    expect(gdcPlayerAction(location.href, "seek", base, 80)).toHaveProperty(
      "error",
    );
  });
  it("loads complete files, follows native language and rebinds a new top document to its player frame", async () => {
    const frameUrl = "https://gdcvault.blazestreaming.com/?id=unit";
    const executeScript = vi.fn(async (request: any) =>
      request.func === gdcPageContext
        ? [{ result: { frameUrl } }]
        : request.args[1] === "describe"
          ? [
              {
                frameId: 2,
                documentId: "iframe-doc",
                result: {
                  source: base,
                  language: "zho",
                  currentTime: 0,
                  tracks: [],
                },
              },
            ]
          : [{ result: { currentTime: 10, language: "zho" } }],
    );
    vi.stubGlobal("chrome", {
      runtime: { id: "localmark" },
      scripting: { executeScript },
    });
    const fetch = vi.fn(async (url: string) => ({
      ok: true,
      text: async () =>
        url === base
          ? '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,NAME="English",LANGUAGE="eng",DEFAULT=YES,URI="en.vtt"\n#EXT-X-MEDIA:TYPE=SUBTITLES,NAME="Chinese",LANGUAGE="zho",URI="zh-list.m3u8"'
          : url.endsWith(".m3u8")
            ? "#EXTM3U\n#EXTINF:6,\n1.vtt\n#EXTINF:6,\n2.vtt\n#EXT-X-ENDLIST"
            : vtt(),
    }));
    vi.stubGlobal("fetch", fetch);
    const sender = {
      id: "localmark",
      frameId: 0,
      documentId: "top-doc",
      url: "https://gdcvault.com/play/123/Talk",
      tab: { id: 90 },
    } as chrome.runtime.MessageSender;
    const result = await gdcTranscriptRequest(
      { key: "gdcvault:123", refresh: true },
      sender,
    );
    expect(result.selected).toContain("zh-list");
    expect(result.cues).toHaveLength(1);
    expect(fetch.mock.calls.some(([url]) => url.endsWith("2.vtt"))).toBe(true);
    await gdcPlaybackRequest(
      { key: "gdcvault:123", action: "seek", seconds: 10 },
      sender,
    );
    expect(executeScript.mock.calls.at(-1)![0].target).toEqual({
      tabId: 90,
      documentIds: ["iframe-doc"],
    });
    await expect(gdcPlaybackRequest(
      { key: "gdcvault:123", action: "seek", seconds: 10 },
      { ...sender, documentId: "new-top" },
    )).resolves.toHaveProperty("currentTime", 10);
    expect(executeScript.mock.calls.at(-1)![0].target).toEqual({ tabId: 90, documentIds: ["iframe-doc"] });
  });
  it("shows HTTP failures rather than treating missing fragments as a complete transcript", async () => {
    vi.stubGlobal("chrome", {
      runtime: { id: "localmark" },
      scripting: {
        executeScript: vi.fn(async (r: any) =>
          r.func === gdcPageContext
            ? [
                {
                  result: {
                    frameUrl: "https://gdcvault.blazestreaming.com/?id=error",
                  },
                },
              ]
            : [
                {
                  documentId: "error-doc",
                  result: {
                    source: base,
                    tracks: [
                      {
                        id: "https://cdn-a.blazestreaming.com/error.vtt",
                        label: "English",
                        language: "eng",
                      },
                    ],
                    language: "eng",
                  },
                },
              ],
        ),
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 403 })),
    );
    await expect(
      gdcTranscriptRequest({ key: "gdcvault:555", refresh: true }, {
        id: "localmark",
        frameId: 0,
        documentId: "top",
        url: "https://gdcvault.com/play/555",
        tab: { id: 91 },
      } as chrome.runtime.MessageSender),
    ).rejects.toThrow("HTTP 403");
  });
});
