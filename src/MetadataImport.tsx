import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import { request } from "./protocol";
import { IMPORT_MAX_BYTES, IMPORT_MAX_FILES, importMetadata, type ImportItem, type ImportResult } from "./metadata-import";
import "./metadata-import.css";

export function MetadataImport({ onImported, showButton = true }: {
  onImported: (result: ImportResult) => void;
  showButton?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const running = useRef(false);
  const callback = useRef(onImported);
  callback.current = onImported;
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [report, setReport] = useState<{ items: ImportItem[]; directoryName?: string; error?: string }>();
  async function importFiles(files: File[]) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      if (!files.length) throw Error("请拖入一个或多个文章元数据 JSON 文件，不支持文件夹。");
      if (files.length > IMPORT_MAX_FILES) throw Error("每批最多导入 500 个文件，请分批导入。");
      if (files.reduce((sum, file) => sum + file.size, 0) > IMPORT_MAX_BYTES)
        throw Error("每批文件总计不能超过 32 MB，请分批导入。");
      const rejected: ImportItem[] = [];
      const readable = [];
      for (const file of files) {
        try {
          if (!/\.json$/i.test(file.name)) throw Error("仅支持文章元数据 .json 文件。");
          if (file.size > 16_000_000) throw Error("单个文件不能超过 16 MB。");
          readable.push({ name: file.name, text: await file.text() });
        } catch (error) {
          rejected.push({ name: file.name, status: "error", message: error instanceof Error ? error.message : "无法读取文件。" });
        }
      }
      if (readable.length) {
        const result = await importMetadata(readable);
        callback.current(result);
        setReport({ ...result, items: [...result.items, ...rejected] });
      } else setReport({ items: rejected });
    } catch (error) {
      setReport({ items: [], error: error instanceof Error ? error.message : String(error) });
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  const start = useRef(importFiles);
  start.current = importFiles;
  useEffect(() => {
    let depth = 0;
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files");
    const enter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault(); depth++; setDragging(true);
    };
    const over = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = running.current ? "none" : "copy";
    };
    const leave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const reset = () => { depth = 0; setDragging(false); };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault(); event.stopPropagation(); reset();
      void start.current(Array.from(event.dataTransfer?.files ?? []));
    };
    window.addEventListener("dragenter", enter, true);
    window.addEventListener("dragover", over, true);
    window.addEventListener("dragleave", leave, true);
    window.addEventListener("drop", drop, true);
    window.addEventListener("dragend", reset);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("dragenter", enter, true);
      window.removeEventListener("dragover", over, true);
      window.removeEventListener("dragleave", leave, true);
      window.removeEventListener("drop", drop, true);
      window.removeEventListener("dragend", reset);
      window.removeEventListener("blur", reset);
    };
  }, []);
  useEffect(() => { if (report && !dialog.current?.open) dialog.current?.showModal(); }, [report]);
  const labels = { saved: "已导入", pending: "待同步", skipped: "已跳过", error: "失败" } as const;
  return <>
    {showButton && <div className="metadata-import-entry">
      <button onClick={() => input.current?.click()} disabled={busy} title="选择文件，或将一个或多个 JSON 拖入此窗口">
        <Icon name="upload" size={14} />{busy ? "正在导入…" : "导入 JSON"}
      </button>
      <input ref={input} type="file" accept=".json,application/json" multiple hidden aria-label="选择元数据 JSON"
        onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ""; if (files.length) void importFiles(files); }} />
    </div>}
    {dragging && createPortal(<div className="metadata-drop-overlay" role="status">
      <strong>{busy ? "正在处理上一批文件" : "松开以导入 JSON"}</strong>
      <p>支持拖入一个或多个 JSON</p>
    </div>, document.body)}
    {report && createPortal(<dialog ref={dialog} className="metadata-import-report" aria-labelledby="metadata-import-title"
      onCancel={() => setReport(undefined)}>
      <header><h2 id="metadata-import-title">导入结果</h2><button autoFocus onClick={() => setReport(undefined)}>关闭</button></header>
      {report.directoryName && <p>目标目录：{report.directoryName}</p>}
      {report.error ? <p className="error" role="alert">{report.error}</p> : <p className="metadata-import-summary" role="status">
        {Object.entries(labels).map(([status, label]) => `${label} ${report.items.filter(item => item.status === status).length}`).join(" · ")}
      </p>}
      <ul>{report.items.map((item, index) => <li key={index}>
        <strong>{item.name}</strong><span className={item.status === "error" ? "error" : ""}>{labels[item.status]}</span>
        <p>{item.message}</p>
      </li>)}</ul>
      <footer><button onClick={() => void request({ type: "settings" }).catch(error => setReport({ ...report, error: String(error) }))}>目录与同步设置</button></footer>
    </dialog>, document.body)}
  </>;
}
