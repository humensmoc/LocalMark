import { useState } from "react";
import { SiteIcon } from "./SiteIcon";

export type TitleDraft = { value: string; base: string | null };

export function PageTitle({ title, savedTitle, draft, change, cancel, save, site }: {
  site?: { url: string; favicon?: string };
  title: string;
  savedTitle: string | null;
  draft?: TitleDraft;
  change: (draft: TitleDraft) => void;
  cancel: () => void;
  save: (draft: TitleDraft) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const stale = !!draft && draft.base !== savedTitle;
  async function submit() {
    if (!draft || busy || stale) return;
    if (!draft.value.trim()) { setError("标题不能为空。"); return; }
    setBusy(true);
    setError("");
    try { await save(draft); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  if (!draft) return (
    <div className="page-title-row">
      {site && <SiteIcon site={site} />}
      <h3>{title}</h3>
      <button className="title-edit" aria-label="编辑标题" title="编辑标题"
        onClick={() => { setError(""); change({ value: title, base: savedTitle }); }}>编辑</button>
    </div>
  );
  return (
    <section className="page-title-editor" aria-label="标题编辑区域">
      <label htmlFor="wc-page-title">网页标题</label>
      <textarea id="wc-page-title" autoFocus rows={3} maxLength={1000}
        value={draft.value} disabled={busy}
        onChange={(e) => { change({ ...draft, value: e.target.value }); setError(""); }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); void submit(); }
          if (e.key === "Escape" && !busy) { e.preventDefault(); cancel(); }
        }} />
      <div className="row spread wrap">
        <small>Ctrl+Enter 保存</small>
        <div className="row">
          <button disabled={busy} onClick={cancel}>取消</button>
          <button className="primary" disabled={busy || stale || !draft.value.trim()}
            onClick={() => void submit()}>{busy ? "保存中…" : "保存标题"}</button>
        </div>
      </div>
      {(error || stale) && <p className="error" role="alert">{error || "标题已有更新，当前输入尚未保存。请复制输入后取消编辑，核对最新标题。"}</p>}
    </section>
  );
}
