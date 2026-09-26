// These functions belong to the simulated WEBSITE, not the extension. The tests
// reject API calls without the site's marker, so a synthetic plugin request fails.
function nativeWebsite(site) {
  const q = () => new URL(location.href);
  if (site === "bilibili") {
    // Keep the SSR tree pending until the test explicitly lets the app mount.
    window.biliServerMarkup =
      document.querySelector(".right-container").innerHTML;
    window.__INITIAL_STATE__ = {
      videoData: {
        bvid: "BVtest",
        aid: 123,
        title: "当前视频",
        pages: [
          { page: 1, cid: 1 },
          { page: 2, cid: 2 },
        ],
      },
    };
    window.nativeBili = async (lan = "en") => {
      const cid = Number(q().searchParams.get("p")) || 1;
      const data = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open(
          "GET",
          `https://api.bilibili.com/x/player/wbi/v2?bvid=BVtest&aid=123&cid=${cid}&w_rid=website-signed`,
        );
        xhr.responseType = "json";
        xhr.onload = () => resolve(xhr.response);
        xhr.onerror = reject;
        xhr.send();
      });
      const track = data.data?.subtitle?.subtitles?.find((t) => t.lan === lan);
      if (track) await fetch(track.subtitle_url).then((r) => r.json());
    };
    void window.nativeBili();
  } else {
    const flexy = document.querySelector("ytd-watch-flexy");
    window.nativeYoutube = async (lan) => {
      const current = q().searchParams.get("v");
      lan = lan || (current === "second" ? "zh" : "en");
      const r = await fetch("/youtubei/v1/get_transcript?prettyPrint=false", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-native-client": "website-context",
        },
        body: JSON.stringify({ params: lan }),
      });
      const data = await r.json();
      if (!r.ok || current !== q().searchParams.get("v")) return;
      window.populateNativeDom(data, lan);
    };
    window.populateNativeDom = (data, lan = "en") => {
      let panel = document.querySelector(
        "ytd-engagement-panel-section-list-renderer",
      );
      if (!panel) {
        panel = document.createElement(
          "ytd-engagement-panel-section-list-renderer",
        );
        panel.setAttribute(
          "target-id",
          "engagement-panel-searchable-transcript",
        );
        document.querySelector("#secondary-inner").append(panel);
      }
      panel.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED");
      panel.replaceChildren();
      const renderer = document.createElement("ytd-transcript-renderer");
      panel.append(renderer);
      for (const item of data.items) {
        const s = item.transcriptSegmentRenderer,
          row = document.createElement("ytd-transcript-segment-renderer");
        row.data = s;
        const time = document.createElement("span");
        time.className = "segment-timestamp";
        time.textContent =
          "0:" + String(Number(s.startMs) / 1000).padStart(2, "0");
        const content = document.createElement("span");
        content.className = "segment-text";
        content.textContent = s.snippet.runs[0].text;
        row.append(time, content);
        renderer.append(row);
      }
      const footer = document.createElement("ytd-transcript-footer-renderer"),
        button = document.createElement("button"),
        menu = document.createElement("tp-yt-paper-listbox");
      button.textContent = lan === "en" ? "English" : "中文";
      button.onclick = () => {
        menu.hidden = !menu.hidden;
      };
      menu.hidden = true;
      for (const [id, label] of [
        ["en", "English"],
        ["zh", "中文"],
      ]) {
        const option = document.createElement("tp-yt-paper-item");
        option.textContent = label;
        option.onclick = () => void window.nativeYoutube(id);
        menu.append(option);
      }
      footer.append(button, menu);
      renderer.append(footer);
    };
    const section = document.createElement(
        "ytd-video-description-transcript-section-renderer",
      ),
      button = document.createElement("button");
    button.textContent = "内容转文字";
    button.onclick = () => void window.nativeYoutube();
    section.append(button);
    flexy.append(section);
  }
}
export function fixture(site) {
  return `<!doctype html><html ${site === "youtube" ? "dark" : ""}><head><meta charset="utf-8"><title>Native transcript fixture</title><style>
body{margin:32px;font:16px Arial;background:${site === "youtube" ? "#0f0f0f" : "white"};color:${site === "youtube" ? "white" : "#222"}}
.layout{display:grid;grid-template-columns:minmax(0,1fr) 370px;gap:24px}video{width:100%;height:480px;background:#171717}.up-info-container{height:80px}#danmukuBox,.recommendation{padding:20px;background:#aaa3}
ytd-transcript-segment-renderer{display:block;font-size:12px}ytd-transcript-renderer{display:block;max-height:160px;overflow:auto}tp-yt-paper-item{cursor:pointer;display:block} [hidden]{display:none!important}
@media(max-width:800px){body{margin:12px}.layout{display:block}video{height:150px}}
</style></head><body>${site === "youtube" ? '<ytd-watch-flexy class="layout" video-id="first"><div id="movie_player"><video class="html5-main-video" src="/test.wav" controls></video></div><div id="secondary"><div id="secondary-inner"><div class="recommendation">接下来播放</div></div></div></ytd-watch-flexy>' : '<div class="layout"><div class="bpx-player-video-wrap"><video src="/test.wav" controls></video></div><div class="right-container"><div class="up-info-container">UP 主信息</div><div id="danmukuBox">弹幕列表</div><div class="recommendation">推荐视频</div></div></div>'}
<script>${site === "bilibili" ? 'const app=document.createElement("div");app.id="app";app.setAttribute("data-server-rendered","true");const layout=document.querySelector(".layout");layout.replaceWith(app);app.append(layout);' : ""}(${nativeWebsite.toString()})(${JSON.stringify(site)})</script></body></html>`;
}
