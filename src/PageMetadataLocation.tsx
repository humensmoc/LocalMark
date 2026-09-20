import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import type { Library } from "./model";
import { locateMetadata, openMetadataLocation, type MetadataLocation } from "./metadata-location";
import { downloadMetadata } from "./metadata-download";

export function PageMetadataLocation({ pageId, library, tell }: {
  pageId?: string;
  library: Library;
  tell: (message: string) => void;
}) {
  const [resolved, setResolved] = useState<{
    library: Library;
    pageId: string;
    location?: MetadataLocation;
    error?: string;
  }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setError("");
    if (pageId) {
      // Resolve before the click so the native picker keeps the user's activation.
      void locateMetadata(pageId).then(
        location => { if (!cancelled) setResolved({ library, pageId, location }); },
        reason => { if (!cancelled) setResolved({ library, pageId, error: reason instanceof Error ? reason.message : String(reason) }); },
      );
    }
    return () => { cancelled = true; };
  }, [pageId, library]);
  const result = resolved?.library === library && resolved.pageId === pageId ? resolved : undefined;
  const location = result?.location;
  const page = pageId ? library.entries[pageId]?.page : undefined;
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
  return (
    <div className="page-metadata-location">
      <div className="row wrap">
        <button className="metadata-open" disabled={!location || busy}
          title={location ? `${location.path}\n在系统文件选择窗口中打开所在目录` : hint || "正在查找本地元数据…"}
          onClick={() => void open()}>
          <Icon name="folder" size={14} />
          {busy ? "正在打开…" : "打开元数据位置"}
        </button>
        {location && <button className="metadata-copy" title={`复制 ${location.fileName}`}
          onClick={() => void copyName()}>复制文件名</button>}
        <button className="metadata-download" disabled={!page}
          title="下载当前已保存的文章 JSON，包含尚未同步到文件夹的改动"
          onClick={() => {
            if (!page) return;
            try { downloadMetadata(page); }
            catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
          }}>
          <Icon name="download" size={14} />下载 JSON
        </button>
      </div>
      {location && <small className="metadata-filename" title={location.path}>{location.fileName}</small>}
      {hint && <small role="status">{hint}</small>}
    </div>
  );
}
