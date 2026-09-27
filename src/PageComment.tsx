import { useState } from "react";

export type CommentDraft = { value: string; base: string };

export function PageComment({ comment, draft, change, reset, save, compact = false }: {
  comment: string;
  draft?: CommentDraft;
  change: (draft: CommentDraft) => void;
  reset: () => void;
  save: (draft: CommentDraft) => Promise<void>;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const value = draft?.value ?? comment;
  const changed = !!draft && draft.value !== draft.base;
  const stale = !!draft && draft.base !== comment;
  async function submit() {
    if (!draft || !changed || busy) return;
    setBusy(true);
    setError("");
    try {
      await save(draft);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="page-comment" aria-label="网页评论区域">
      {!compact && <label htmlFor="wc-page-comment">网页评论</label>}
      <textarea
        id="wc-page-comment"
        aria-label={compact ? "网页评论" : undefined}
        placeholder="写下对这个网页的想法，无需选中文字…"
        value={value}
        maxLength={100000}
        disabled={busy}
        onChange={(e) => change({ value: e.target.value, base: draft?.base ?? comment })}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <div className={compact ? "row wrap comment-actions-compact" : "row spread wrap"}>
        {!compact && <small>{changed ? "有未保存的修改" : "无需高亮，可单独保存"}</small>}
        <button className="primary" disabled={!changed || busy} onClick={() => void submit()}>
          {busy ? "保存中…" : "保存评论"}
        </button>
      </div>
      {(stale || error) && <p className="error" role="alert">{error || "评论已有更新，当前输入尚未保存。请先复制输入，再读取最新评论核对。"}</p>}
      {(draft || error) && <button disabled={busy} onClick={() => { reset(); setError(""); }}>读取最新评论</button>}
    </section>
  );
}
