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
  it("retains a user's language selection made during a native background refresh", async () => {
    let reply!: (value: any) => void;
    await mount(sites[0], async (m) =>
      m.type === "video-transcript-ping"
        ? { ok: true, version: "test" }
        : new Promise((r) => {
            reply = r;
          }),
    );
    const initial = response(sites[0].key);
    initial.data.tracks.push({ id: "zh", label: "中文" });
    await act(async () => {
      reply(initial);
    });
    document.dispatchEvent(new Event("localmark-native-subtitles"));
    await advance(201);
    await act(async () => {
      const select = shadow().querySelector("select")!;
      select.value = "zh";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      reply(initial);
    });
    await advance(1);
    expect(
      vi.mocked(chrome.runtime.sendMessage).mock.calls.at(-1)![0],
    ).toMatchObject({ type: "video-transcript", trackId: "zh" });
    await act(async () => {
      reply({ ...initial, data: { ...initial.data, selected: "zh" } });
    });
    expect(shadow().querySelector("select")!.value).toBe("zh");
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
