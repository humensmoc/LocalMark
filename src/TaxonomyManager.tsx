import { useEffect, useRef, useState } from "react";
import type { Library } from "./model";
import type { Request } from "./protocol";
import { Icon } from "./Icon";
import { taxonomyToken, UNCATEGORIZED, type TaxonKind, type TaxonomyAction } from "./taxonomy";

export function TaxonomyManager({ lib, mutate, close, initialKind = "categories", initialId, createOnly = false }: {
  lib: Library; mutate: (m: Request) => Promise<unknown>; close: () => void;
  initialKind?: TaxonKind; initialId?: string;
  createOnly?: boolean;
}) {
  const initialItem = !createOnly ? lib.taxonomy?.[initialKind].find(x => x.id === initialId && x.id !== UNCATEGORIZED) : undefined;
  const [kind, setKind] = useState<TaxonKind>(initialKind);
  const [query, setQuery] = useState("");
  const [name, setName] = useState(initialItem?.name ?? "");
  const [editing, setEditing] = useState<{ id: string; expected: string } | undefined>(initialItem ? { id: initialItem.id, expected: taxonomyToken(lib) } : undefined);
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
  const filtered = catalog.filter(x => x.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  async function run(action: TaxonomyAction, expected = editing?.expected ?? taxonomyToken(lib)) {
    setBusy(true); setError(""); setNotice("");
    try {
      await mutate({ type: "taxonomy", action, expected });
      if (createOnly) { close(); return; }
      setEditing(undefined); setName(""); setTarget(""); setNotice("已保存到浏览器，文件同步状态请查看底栏。");
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  return <dialog className="taxonomy-dialog" ref={dialog} aria-label={createOnly ? `新建${noun}` : "分类与标签管理"} onCancel={e => { e.preventDefault(); if (!busy) close(); }}>
    <header className="taxonomy-header">
      <div className="taxonomy-heading"><span className="taxonomy-heading-icon"><Icon name={kind === "categories" ? "folder" : "tag"} size={22} /></span>
        <div><h2>{createOnly ? `新建${noun}` : "分类与标签管理"}</h2><p>{createOnly ? `为资料库添加一个${noun}` : "整理整个资料库的分类与标签，网页和高亮内容会保留。"}</p></div>
      </div>
      <button className="taxonomy-close" disabled={busy} onClick={close} aria-label={createOnly ? "取消" : "关闭管理"} title={createOnly ? "取消" : "关闭管理"}><Icon name="close" /></button>
    </header>
    {lib.taxonomyIssue && <div className="error" role="alert">
      <p>{lib.taxonomyIssue}</p>
      <div className="row wrap">{(["local", "disk"] as const).map(choice => <button key={choice} disabled={busy} onClick={async () => {
        if (!window.confirm("将备份被替换的分类数据，再采用选定版本。继续？")) return;
        setBusy(true); setError("");
        try { await mutate({ type: "resolve-taxonomy", choice }); } catch (e) { setError(String(e)); } finally { setBusy(false); }
      }}>{choice === "local" ? "备份后保留浏览器分类" : "备份后读取文件分类"}</button>)}</div>
    </div>}
    <fieldset disabled={busy || !!lib.taxonomyIssue}>
      {!createOnly && <><div className="taxonomy-tabs" role="group" aria-label="管理类型">
        {(["categories", "tags"] as const).map(k => <button key={k} aria-pressed={kind === k} onClick={() => {
          setKind(k); setEditing(undefined); setName(""); setQuery(""); setTarget(""); setError(""); setNotice("");
        }} aria-label={k === "categories" ? "主分类" : "标签"}><Icon name={k === "categories" ? "folder" : "tag"} size={16} />{k === "categories" ? "主分类" : "标签"}<small>{lib.taxonomy?.[k].length ?? 0}</small></button>)}
      </div>
      <div className="taxonomy-search"><input aria-label="搜索分类或标签" placeholder={`搜索${noun}名称…`} value={query} onChange={e => setQuery(e.target.value)} /><small>{filtered.length} 个{noun}</small></div>
      <div className="taxonomy-list">
        {filtered.map(x => <button type="button" className={`taxonomy-row${source?.id === x.id ? " selected" : ""}`} key={x.id}
          aria-label={`管理“${x.name}”`} aria-pressed={source?.id === x.id} disabled={x.id === UNCATEGORIZED}
          onClick={() => { setEditing({ id: x.id, expected: taxonomyToken(lib) }); setName(x.name); setTarget(""); setError(""); }}>
          <Icon name={kind === "categories" ? "folder" : "tag"} size={16} /><span>{x.name}</span><small>{count(x.id)} 篇网页</small><Icon name="arrow" size={14} />
        </button>)}
        {!filtered.length && <p className="taxonomy-empty">{catalog.length ? "没有匹配的名称" : `暂无${noun}，可以在下方新建。`}</p>}
      </div></>}
      <form className="taxonomy-edit" onSubmit={e => {
        e.preventDefault();
        const duplicate = catalog.find(x => x.name === name.trim() && x.id !== source?.id);
        if (source && duplicate) {
          if (window.confirm(`“${duplicate.name}”已存在。将“${source.name}”的 ${count(source.id)} 篇网页合并到此${noun}？`))
            void run({ operation: "merge", kind, id: source.id, targetId: duplicate.id });
        } else void run(source ? { operation: "rename", kind, id: source.id, name } : { operation: "create", kind, name });
      }}>
        <label>{source ? `重命名“${source.name}”` : `新建${noun}`}<input aria-label="分类或标签名称" placeholder={`输入${noun}名称`} maxLength={100} required value={name} onChange={e => setName(e.target.value)} /></label>
        <div className="row wrap"><button className="primary" type="submit">{source ? "保存名称" : "新建"}</button>
          {source && <button className="taxonomy-secondary" type="button" onClick={() => { setEditing(undefined); setName(""); setTarget(""); }}>取消编辑</button>}</div>
      </form>
      {source && <div className="taxonomy-danger">
        <div className="taxonomy-section-heading"><strong>合并与移除</strong><small>关联 {count(source.id)} 篇网页</small></div>
        <label>转入目标<select aria-label="转入目标" value={target} onChange={e => setTarget(e.target.value)}>
          <option value="">{kind === "categories" ? "未分类（删除时默认）" : "仅移除标签（删除时默认）"}</option>
          {catalog.filter(x => x.id !== source.id).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select></label>
        <div className="row wrap">
          <button className="taxonomy-secondary" disabled={!target} onClick={() => {
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
    {notice && <p className="taxonomy-notice" role="status">{notice}</p>}
  </dialog>;
}
