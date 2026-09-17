import { useEffect, useRef, useState } from "react";
import type { Library } from "./model";
import type { Request } from "./protocol";
import { taxonomyToken, UNCATEGORIZED, type TaxonKind, type TaxonomyAction } from "./taxonomy";

export function TaxonomyManager({ lib, mutate, close }: {
  lib: Library; mutate: (m: Request) => Promise<unknown>; close: () => void;
}) {
  const [kind, setKind] = useState<TaxonKind>("categories");
  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<{ id: string; expected: string }>();
  const [target, setTarget] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const catalog = lib.taxonomy?.[kind] ?? [];
  const noun = kind === "categories" ? "主分类" : "标签";
  const count = (id: string) => Object.values(lib.entries).filter(e => kind === "categories"
    ? e.page.categoryId === id : e.page.tagIds?.includes(id)).length;
  const source = catalog.find(x => x.id === editing?.id);
  async function run(action: TaxonomyAction, expected = editing?.expected ?? taxonomyToken(lib)) {
    setBusy(true); setError(""); setNotice("");
    try {
      await mutate({ type: "taxonomy", action, expected });
      setEditing(undefined); setName(""); setTarget(""); setNotice("已保存到浏览器，文件同步状态请查看底栏。");
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  return <dialog className="taxonomy-dialog" ref={dialog} aria-label="分类与标签管理" onCancel={e => { e.preventDefault(); if (!busy) close(); }}>
    <div className="row spread"><h2>分类与标签管理</h2><button disabled={busy} onClick={close}>关闭管理</button></div>
    <p>这里的重命名、合并和删除会作用于整个资料库。文章及高亮内容保留。</p>
    {lib.taxonomyIssue && <div className="error" role="alert">
      <p>{lib.taxonomyIssue}</p>
      <div className="row wrap">{(["local", "disk"] as const).map(choice => <button key={choice} disabled={busy} onClick={async () => {
        if (!window.confirm("将备份被替换的分类数据，再采用选定版本。继续？")) return;
        setBusy(true); setError("");
        try { await mutate({ type: "resolve-taxonomy", choice }); } catch (e) { setError(String(e)); } finally { setBusy(false); }
      }}>{choice === "local" ? "备份后保留浏览器分类" : "备份后读取文件分类"}</button>)}</div>
    </div>}
    <fieldset disabled={busy || !!lib.taxonomyIssue}>
      <div className="row" role="group" aria-label="管理类型">
        {(["categories", "tags"] as const).map(k => <button key={k} aria-pressed={kind === k} onClick={() => {
          setKind(k); setEditing(undefined); setName(""); setQuery(""); setTarget(""); setError(""); setNotice("");
        }}>{k === "categories" ? "主分类" : "标签"}</button>)}
      </div>
      <input aria-label="搜索分类或标签" placeholder="搜索名称…" value={query} onChange={e => setQuery(e.target.value)} />
      <div className="taxonomy-list">
        {catalog.filter(x => x.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(x => <div className="taxonomy-row" key={x.id}>
          <span>{x.name}</span><small>{count(x.id)} 篇</small>
          <button disabled={x.id === UNCATEGORIZED} onClick={() => { setEditing({ id: x.id, expected: taxonomyToken(lib) }); setName(x.name); setTarget(""); setError(""); }}>管理“{x.name}”</button>
        </div>)}
        {!catalog.length && <p>暂无{noun}，可以在下方新建。</p>}
      </div>
      <form onSubmit={e => {
        e.preventDefault();
        const duplicate = catalog.find(x => x.name === name.trim() && x.id !== source?.id);
        if (source && duplicate) {
          if (window.confirm(`“${duplicate.name}”已存在。将“${source.name}”的 ${count(source.id)} 篇网页合并到此${noun}？`))
            void run({ operation: "merge", kind, id: source.id, targetId: duplicate.id });
        } else void run(source ? { operation: "rename", kind, id: source.id, name } : { operation: "create", kind, name });
      }}>
        <label>{source ? `重命名“${source.name}”` : `新建${noun}`}<input aria-label="分类或标签名称" maxLength={100} required value={name} onChange={e => setName(e.target.value)} /></label>
        <div className="row wrap"><button type="submit">{source ? "保存名称" : "新建"}</button>
          {source && <button type="button" onClick={() => { setEditing(undefined); setName(""); }}>取消编辑</button>}</div>
      </form>
      {source && <div className="taxonomy-danger">
        <label>转入目标<select aria-label="转入目标" value={target} onChange={e => setTarget(e.target.value)}>
          <option value="">{kind === "categories" ? "未分类（删除时默认）" : "仅移除标签（删除时默认）"}</option>
          {catalog.filter(x => x.id !== source.id).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select></label>
        <div className="row wrap">
          <button disabled={!target} onClick={() => {
            if (window.confirm(`将“${source.name}”的 ${count(source.id)} 篇网页并入所选目标，并移除原${noun}？`))
              void run({ operation: "merge", kind, id: source.id, targetId: target });
          }}>合并到目标</button>
          <button className="danger" onClick={() => {
            if (window.confirm(`删除${noun}“${source.name}”，影响 ${count(source.id)} 篇网页。${kind === "categories" ? "网页将转入所选分类或未分类。" : target ? "标签关联将转入所选目标。" : "仅移除此标签关联。"}网页、评论和高亮均保留。`))
              void run({ operation: "delete", kind, id: source.id, targetId: target || undefined });
          }}>删除{noun}</button>
        </div>
      </div>}
    </fieldset>
    {error && <p role="alert" className="error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </dialog>;
}
