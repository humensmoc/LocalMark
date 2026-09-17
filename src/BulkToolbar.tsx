import { useEffect, useState } from "react";
import type { Library, Page } from "./model";
import type { Request } from "./protocol";
import { relationToken, taxonomyToken, type BulkAction } from "./taxonomy";

export function BulkToolbar({ lib, selected, visible, select, mutate }: {
  lib: Library; selected: string[]; visible: Page[];
  select: (ids: string[]) => void; mutate: (m: Request) => Promise<unknown>;
}) {
  const [editor, setEditor] = useState<{ operation: BulkAction["operation"]; expected: string; selected: Record<string, string> }>();
  const [ids, setIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => { setEditor(undefined); setIds([]); }, [JSON.stringify(selected)]);
  const catalog = editor?.operation === "category" ? lib.taxonomy?.categories : lib.taxonomy?.tags;
  const selectedPages = selected.map(id => lib.entries[id]?.page).filter((p): p is Page => !!p);
  function open(operation: BulkAction["operation"]) {
    setEditor({ operation, expected: taxonomyToken(lib), selected: Object.fromEntries(selectedPages.map(p => [p.id, relationToken(p)])) });
    setIds([]); setError(""); setNotice("");
  }
  const actual = selectedPages.filter(p => editor?.operation === "category" ? p.categoryId !== ids[0]
    : editor?.operation === "add-tags" ? ids.some(id => !p.tagIds?.includes(id)) : ids.some(id => p.tagIds?.includes(id))).length;
  return <div className="bulk-toolbar" aria-label="批量整理">
    <div className="row wrap">
      <b>已选 {selected.length} 篇</b>
      <button disabled={busy || !visible.length} onClick={() => { select(visible.map(p => p.id)); setEditor(undefined); }}>全选当前筛选结果（{visible.length} 篇）</button>
      {!!selected.length && <button disabled={busy} onClick={() => { select([]); setEditor(undefined); }}>取消选择</button>}
    </div>
    {!!selected.length && <div className="row wrap">
      <button disabled={busy} onClick={() => open("category")}>更改主分类</button>
      <button disabled={busy} onClick={() => open("add-tags")}>添加标签</button>
      <button disabled={busy} onClick={() => open("remove-tags")}>移除标签</button>
    </div>}
    {editor && <fieldset disabled={busy}>
      <legend>{editor.operation === "category" ? "选择一个主分类" : "选择标签（可多选）"}</legend>
      <div className="bulk-options">{catalog?.map(x => <label key={x.id}>
        <input type={editor.operation === "category" ? "radio" : "checkbox"} name="bulk-taxonomy" checked={ids.includes(x.id)} onChange={() => setIds(editor.operation === "category" ? [x.id] : ids.includes(x.id) ? ids.filter(id => id !== x.id) : [...ids, x.id])} />
        <span>{x.name}</span>{editor.operation !== "category" && <small>{selectedPages.filter(p => p.tagIds?.includes(x.id)).length}/{selected.length} 篇</small>}
      </label>)}</div>
      {!catalog?.length && <p>暂无标签，请先在“分类与标签管理”中新建。</p>}
      <div className="row wrap"><button disabled={!ids.length} onClick={async () => {
        setBusy(true); setError("");
        try {
          await mutate({ type: "bulk-taxonomy", selected: editor.selected, action: { operation: editor.operation, ids }, expected: editor.expected });
          setNotice(`已修改 ${actual} 篇，${selected.length - actual} 篇无需修改；文件同步状态请查看底栏。`);
          setEditor(undefined); select([]);
        } catch (e) { setError(String(e)); }
        finally { setBusy(false); }
      }}>应用到所选网页（{actual} 篇有变化）</button><button onClick={() => setEditor(undefined)}>取消操作</button></div>
    </fieldset>}
    {error && <p role="alert" className="error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </div>;
}
