import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import * as db from "./db";
import { emptyLibrary, type Entry, type Library } from "./model";
import { request } from "./protocol";
import { Icon } from "./Icon";
import "./settings.css";
function Settings() {
  const [lib, setLib] = useState<Library>(emptyLibrary()),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [directoryReady, setDirectoryReady] = useState(false),
    [preview, setPreview] = useState<Entry | null>(null);
  const directory = useRef<FileSystemDirectoryHandle | undefined>(undefined);
  async function run(fn: () => Promise<Library>) {
    setBusy(true);
    setError("");
    try {
      setLib(await fn());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    // Load the handle before the user clicks so permission is requested during that gesture.
    void db
      .get<FileSystemDirectoryHandle>("root")
      .then((root) => {
        directory.current = root;
        setDirectoryReady(true);
      })
      .catch((e) => setError(String(e)));
    void run(() => request({ type: "snapshot", refresh: true }));
    const listener = (m: { type: string }) => {
      if (m.type === "changed")
        request({ type: "snapshot" })
          .then(setLib)
          .catch(() => {});
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);
  async function pick() {
    try {
      const root = await window.showDirectoryPicker({
        mode: "readwrite",
        id: "web-clipper-root",
      });
      const old = await db.get<FileSystemDirectoryHandle>("root");
      if (
        old &&
        !(await root.isSameEntry(old)) &&
        !window.confirm(
          "切换文件夹会把浏览器中的摘录合并到新目录；同页数据冲突时由你选择版本。旧目录保持原样。是否继续？",
        )
      )
        return;
      await db.set("pendingRoot", root);
      await run(() => request({ type: "directory-connected" }));
      directory.current = root;
      setDirectoryReady(true);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError"))
        setError(String(e));
    }
  }
  async function reconnect() {
    const root = directory.current;
    if (!root) {
      await pick();
      return;
    }
    try {
      const result = await root.requestPermission({ mode: "readwrite" });
      if (result !== "granted") {
        setError("未获得文件夹读写权限；浏览器暂存内容仍保留。");
        return;
      }
      await run(() => request({ type: "snapshot", refresh: true }));
    } catch (e) {
      setError(String(e));
    }
  }
  const entries = Object.values(lib.entries),
    issues = entries.filter((e) => e.issue);
  return (
    <main>
      <header>
        <div className="brand">
          <span className="logo">
            <Icon name="pen" size={26} />
          </span>
          <div>
            <h1>本地摘录</h1>
            <p>网页里阅读，文件夹里保存。</p>
          </div>
        </div>
        <span className="version">
          Chrome 扩展 · {chrome.runtime.getManifest().version}
        </span>
      </header>
      <section>
        <h2>集中整理文章</h2>
        <p>在大窗口中筛选文章，编辑分类、标签、网页评论和高亮批注。</p>
        <button className="primary" onClick={() => void run(() => request({ type: "dashboard" }))}>打开文章管理</button>
      </section>
      <section>
        <h2>连接你的本地文件夹</h2>
        <p>
          选择一个用于摘录的专用文件夹，也可以放在 Obsidian Vault 内。每页一个
          Markdown，原始数据单独保存在 JSON 中。
        </p>
        <div className="directory">
          <Icon name="folder" size={25} />
          <div>
            <strong>{lib.directoryName ?? "尚未选择文件夹"}</strong>
            <p className="status">{lib.status}</p>
          </div>
        </div>
        <div className="actions">
          <button
            className="primary"
            disabled={busy}
            onClick={() => void pick()}
          >
            选择文件夹
          </button>
          <button
            disabled={busy || !directoryReady}
            onClick={() => void reconnect()}
          >
            重新授权
          </button>
          <button
            disabled={busy}
            onClick={() =>
              void run(() => request({ type: "snapshot", refresh: true }))
            }
          >
            <Icon name="refresh" />
            刷新本地数据
          </button>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="stats">
          <div>
            <strong>{entries.length}</strong>
            <span>已保存网页</span>
          </div>
          <div>
            <strong>
              {entries.reduce((n, e) => n + e.page.annotations.length, 0)}
            </strong>
            <span>高亮摘录</span>
          </div>
          <div>
            <strong>
              {entries.filter((e) => e.dirty || e.mdDirty).length}
            </strong>
            <span>待同步网页</span>
          </div>
          <div>
            <strong>{issues.length}</strong>
            <span>需处理</span>
          </div>
        </div>
      </section>
      {(issues.length > 0 || lib.errors.length > 0) && (
        <section>
          <h2>同步与冲突</h2>
          <p>
            发生冲突时暂停覆盖。选择版本前，可查看浏览器内容和文件内容；被替换的版本会先写入“冲突备份”文件夹。
          </p>
          {issues.map((e) => (
            <article key={e.page.id}>
              <h3>{e.page.title}</h3>
              <p className="error">{e.issue?.message}</p>
              <div className="actions">
                <button onClick={() => setPreview(e)}>查看版本</button>
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      request({
                        type: "resolve",
                        pageId: e.page.id,
                        choice: "local",
                      }),
                    )
                  }
                >
                  {e.issue?.kind === "markdown"
                    ? "备份手改内容并重新生成"
                    : "保留浏览器版本（先备份文件）"}
                </button>
                {e.issue?.kind !== "markdown" && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        request({
                          type: "resolve",
                          pageId: e.page.id,
                          choice: "disk",
                        }),
                      )
                    }
                  >
                    {e.issue?.kind === "missing"
                      ? "接受文件删除（先备份缓存）"
                      : "使用本地 JSON（先备份缓存）"}
                  </button>
                )}
              </div>
            </article>
          ))}
          {lib.errors.map((e, i) => (
            <p className="error" key={i}>
              {e}
            </p>
          ))}
        </section>
      )}
      <section>
        <h2>怎么使用</h2>
        <ol>
          <li>
            在普通网页选中文字，点击笔形按钮保存；悬停按钮可选颜色、写批注。网页标签在侧栏“当前页面”中添加，点击
            + 可以搜索已有标签或新建。
          </li>
          <li>
            点击浏览器工具栏的插件图标，打开左侧的最近网页、标签和当前页面列表。
          </li>
          <li>
            悬停原文高亮查看批注，点击高亮编辑；点击侧栏摘录或左侧彩色轨迹回到原文。
          </li>
          <li>
            本地 JSON 修改后，重开网页、打开侧栏或点击“刷新本地数据”读回。保留
            ID、URL、folderName、markdownFile 与定位字段；批注修改 annotations
            中的 note、color，网页标签修改顶层 tags。
          </li>
        </ol>
        <pre>
          {"摘录根目录/\n├── 网页标题.md\n└── 原始数据/\n    └── 网页ID.json"}
        </pre>
        <p className="tip">
          Markdown
          是自动生成的阅读副本，不反向同步。检测到手改会暂停覆盖。浏览器重启后若目录权限失效，点击“重新授权”。未连接或无权限时只暂存浏览器。
        </p>
      </section>
      <footer>
        只处理普通 HTTP/HTTPS 网页；Chrome 内部页面、扩展商店、PDF
        和跨域内嵌页面不支持标注。不上传批注，不需要账号。
      </footer>
      {preview && (
        <div className="modal" role="dialog" aria-label="冲突版本">
          <div className="modal-body">
            <div className="actions spread">
              <h2>{preview.page.title}</h2>
              <button onClick={() => setPreview(null)}>关闭</button>
            </div>
            <h3>浏览器版本</h3>
            <pre>{JSON.stringify(preview.page, null, 2)}</pre>
            <h3>本地文件版本（发现冲突时）</h3>
            <pre>
              {preview.issue?.external ??
                "文件不可读或已删除。请在文件管理器中检查原始数据。"}
            </pre>
          </div>
        </div>
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Settings />);
