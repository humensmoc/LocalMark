import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import type { Library } from "./model";
import { locateMetadata, openMetadataLocation, type MetadataLocation } from "./metadata-location";
import { downloadMetadata } from "./metadata-download";
import { request } from "./protocol";

export function PageMetadataLocation({ pageId, library, tell, onDeleted }: {
  pageId?: string;
  library: Library;
  tell: (message: string) => void;
  onDeleted: (library: Library) => void;
}) {
  const [resolved, setResolved] = useState<{
    pageId: string;
    directoryName?: string;
    title?: string;
    location?: MetadataLocation;
    error?: string;
  }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const page = pageId ? library.entries[pageId]?.page : undefined;
  useEffect(() => {
    let cancelled = false;
    setError("");
    if (pageId) {
      // Resolve before the click so the native picker keeps the user's activation.
      void locateMetadata(pageId).then(
        location => { if (!cancelled) setResolved({ pageId, directoryName: library.directoryName, title: page?.title, location }); },
        reason => { if (!cancelled) setResolved({ pageId, directoryName: library.directoryName, title: page?.title, error: reason instanceof Error ? reason.message : String(reason) }); },
      );
    }
    return () => { cancelled = true; };
  }, [pageId, library]);
  const result = resolved && resolved.pageId === pageId && resolved.directoryName === library.directoryName && resolved.title === page?.title
    ? resolved : undefined;
  const location = result?.location;
  const hint = error || (!pageId
    ? "保存评分、标签或评论后可打开元数据位置。"
    : result?.error ?? "");
  async function open() {
    if (!location || busy) return;
    setBusy(true);
    setError("");
    try { await openMetadataLocation(location); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  async function copyName() {
    if (!location) return;
    try {
      await navigator.clipboard.writeText(location.fileName);
      tell("已复制元数据文件名，可粘贴到文件窗口中定位。");
    } catch { setError("复制失败，文件名：" + location.fileName); }
  }
  async function removePage() {
    if (!page || busy || !window.confirm(`删除“${page.title}”的全部标注和网页数据？对应的 JSON、自动生成的 Markdown 和截图文件也会删除。此操作无法撤销。`)) return;
    setBusy(true);
    setError("");
    try {
      const next = await request({ type: "page-delete", pageId: page.id, expectedUpdatedAt: page.updatedAt });
      onDeleted(next);
      tell("已删除该网页的全部标注和本地文件。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  return (
    <div className="page-metadata-location">
      <div className="row wrap">
        <button className="metadata-open" disabled={!location || busy} aria-label="打开元数据位置"
          title={location ? `${location.path}\n在系统文件选择窗口中打开所在目录` : hint || "正在查找本地元数据…"}
          onClick={() => void open()}>
          <Icon name="folder" size={14} />
        </button>
        <button className="metadata-copy" disabled={!location} title={location ? `复制 ${location.fileName}` : hint || "正在查找本地元数据…"}
          onClick={() => void copyName()}>复制文件名</button>
        <button className="metadata-download" disabled={!page} aria-label="下载 JSON"
          title="下载当前已保存的文章 JSON，包含尚未同步到文件夹的改动"
          onClick={() => {
            if (!page) return;
            try { downloadMetadata(page); }
            catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
          }}>
          <Icon name="download" size={14} />
        </button>
        <button className="metadata-delete danger" disabled={!page || busy} aria-label="删除当前网页全部标注和文件"
          title="删除当前网页全部标注、JSON、自动生成的 Markdown 和截图文件"
          onClick={() => void removePage()}><Icon name="trash" size={14} />删除</button>
      </div>
      {hint && <small role="status">{hint}</small>}
    </div>
  );
}
