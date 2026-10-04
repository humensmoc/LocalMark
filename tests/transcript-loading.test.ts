// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { mountVideoTranscript } from "../src/VideoTranscript";
import { transcriptRequest } from "../src/video-transcript";

let dispose: (() => void) | undefined;
const never = () => new Promise<any>(() => {});
const sites = [
  {
    url: "https://www.youtube.com/watch?v=test",
    key: "youtube:test",
    html: '<ytd-watch-flexy><div id="secondary-inner"></div></ytd-watch-flexy>',
    limit: 20000,
  },
  {
    url: "https://www.bilibili.com/video/BVtest",
    key: "bilibili:BVtest:1",
    html: '<div class="right-container"><div id="danmukuBox"></div></div>',
    limit: 20000,
  },
  {
    url: "https://gdcvault.com/play/123/Talk",
    key: "gdcvault:123",
    html: '<div id="player"><aside class="right_column"><dl class="player-info"></dl></aside></div>',
    limit: 90000,
  },
];
function response(key: string) {
  return {
    ok: true,
    data: {
      key,
      source: "Native",
      tracks: [{ id: "en", label: "English" }],
      selected: "en",
      cues: [{ start: 0, end: 3, text: "Native subtitle" }],
    },
  };
}
const shadow = () =>
  document.getElementById("localmark-video-transcript")!.shadowRoot!;
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
async function mount(
  site: (typeof sites)[number],
  send: (m: any) => Promise<any>,
) {
  vi.stubGlobal("location", new URL(site.url));
  vi.stubGlobal("chrome", {
    runtime: { id: "localmark", sendMessage: vi.fn(send) },
    storage: { local: { get: vi.fn(async () => ({})) }, onChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
  });
  document.body.innerHTML = site.html;
  await act(async () => {
    dispose = mountVideoTranscript();
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("__LOCALMARK_VERSION__", "test");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  await act(async () => {
    dispose?.();
  });
  dispose = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("subtitle loading lifecycle", () => {
  for (const site of sites) {
    it(`${site.key}: a silent worker ends loading with a retryable connection error`, async () => {
      await mount(site, never);
      await advance(6001);
      expect(shadow().querySelector('[aria-busy="true"]')).toBeNull();
      expect(shadow().querySelector('[role="alert"]')?.textContent).toContain(
        "后台未响应",
      );
      expect(
        shadow().querySelector<HTMLButtonElement>(".retry")!.disabled,
      ).toBe(false);
      // Recovery uses the actual retry button, with no page refresh.
      vi.mocked(chrome.runtime.sendMessage).mockImplementation(
        async (m: any) =>
          m.type === "video-transcript-ping"
            ? { ok: true, version: "test" }
            : response(site.key),
      );
      await act(async () => {
        shadow().querySelector<HTMLButtonElement>(".retry")!.click();
      });
      expect(shadow().querySelector(".cue")?.textContent).toContain(
        "Native subtitle",
      );
    });
    it(`${site.key}: a silent read cannot load forever or accept a late reply`, async () => {
      let reply!: (value: any) => void;
      await mount(site, async (m) =>
        m.type === "video-transcript-ping"
          ? { ok: true, version: "test" }
          : new Promise((r) => {
              reply = r;
            }),
      );
      await advance(site.limit + 1);
      expect(shadow().querySelector('[role="alert"]')?.textContent).toContain(
        "后台已连接",
      );
      await act(async () => {
        reply(response(site.key));
      });
      expect(shadow().querySelector(".cue")).toBeNull();
      expect(shadow().querySelector('[aria-busy="true"]')).toBeNull();
    });
  }
  it("coalesces native notifications while accepting the running result and keeps rows during refresh", async () => {
    let reply!: (value: any) => void,
      reads = 0;
    await mount(sites[0], async (m) =>
      m.type === "video-transcript-ping"
        ? { ok: true, version: "test" }
        : (reads++,
          new Promise((r) => {
            reply = r;
          })),
    );
    for (let i = 0; i < 8; i++) {
      document.dispatchEvent(new Event("localmark-native-subtitles"));
      await advance(300);
    }
    expect(reads).toBe(1);
    await act(async () => {
      reply(response(sites[0].key));
    });
    expect(shadow().querySelector(".cue")).not.toBeNull();
    await advance(201);
    expect(reads).toBe(2);
    expect(shadow().querySelector(".cue")).not.toBeNull();
    expect(shadow().querySelector('[aria-busy="true"]')).toBeNull();
  });
  it("identifies an older page build talking to a newer worker", async () => {
    await mount(sites[0], async () => ({ ok: true, version: "newer" }));
    expect(shadow().querySelector('[role="alert"]')?.textContent).toContain(
      "网页脚本 vtest 与扩展后台 vnewer不一致",
    );
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });
  it("replaces the language selector with a Markdown download of the loaded transcript", async () => {
    const createObjectURL = vi.fn(() => "blob:localmark-test");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await mount(sites[0], async (m) => m.type === "video-transcript-ping"
      ? { ok: true, version: "test" }
      : m.source === "player"
        ? { ok: true, data: { ...response(sites[0].key).data,
          source: "YouTube · 播放器字幕", selected: "player:en",
          cues: [{ start: 1, end: 2, text: "Player sentence" }] } }
        : response(sites[0].key));
    expect(shadow().querySelector("#lm-transcript-language")).toBeNull();
    const button = shadow().querySelector<HTMLButtonElement>('[aria-label="下载视频字幕 Markdown"]')!;
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(click.mock.instances[0].download).toMatch(/字幕\.md$/);
    expect(vi.mocked(chrome.runtime.sendMessage).mock.calls.some(([m]) =>
      m.type === "video-transcript" && m.source === "player")).toBe(true);
    expect(vi.mocked(chrome.runtime.sendMessage).mock.calls.filter(([m]) => m.type === "video-transcript")
      .every(([m]) => !("trackId" in m))).toBe(true);
  });
  it("disables transcript download while subtitles are unavailable", async () => {
    await mount(sites[0], async (m) => m.type === "video-transcript-ping"
      ? { ok: true, version: "test" }
      : { ok: false, error: "字幕不可用" });
    expect(shadow().querySelector<HTMLButtonElement>('[aria-label="下载视频字幕 Markdown"]')?.disabled).toBe(true);
    expect(shadow().querySelector("#lm-transcript-language")).toBeNull();
  });
  it("does not download an incomplete YouTube file if the player subtitles fail", async () => {
    const createObjectURL = vi.fn(() => "blob:localmark-test");
    vi.stubGlobal("URL", class extends URL { static createObjectURL = createObjectURL; });
    await mount(sites[0], async (m) => m.type === "video-transcript-ping"
      ? { ok: true, version: "test" }
      : m.source === "player"
        ? { ok: false, error: "播放器字幕不可用" }
        : response(sites[0].key));
    await act(async () => shadow().querySelector<HTMLButtonElement>('[aria-label="下载视频字幕 Markdown"]')!.click());
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(shadow().querySelector('[role="alert"]')?.textContent).toContain("播放器字幕不可用");
  });
  for (const site of sites) {
    it(`${site.key}: reports script injection timeout instead of leaving the worker request pending`, async () => {
      vi.stubGlobal("chrome", {
        runtime: { id: "localmark" },
        scripting: { executeScript: vi.fn(never) },
      });
      const request = transcriptRequest({ key: site.key }, {
        id: "localmark",
        frameId: 0,
        documentId: "top",
        tab: { id: 1 },
        url: site.url,
      } as chrome.runtime.MessageSender);
      const rejected = expect(request).rejects.toThrow(
        site.key.startsWith("gdcvault") ? "页面超时" : "网页字幕超时",
      );
      await advance(15001);
      await rejected;
    });
  }
});
