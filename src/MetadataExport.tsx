import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Page } from "./model";
import { applyMetadataExport, exportSummary, metadataDifferences, prepareMetadataExport, type ExportChoice, type ExportPlan } from "./metadata-export";
import "./metadata-export.css";

export function MetadataExport({ pages, disabled, onBusy, onResult }: {
  pages: Page[]; disabled: boolean; onBusy: (busy: boolean) => void; onResult: (message: string, error?: boolean) => void;
}) {
  const [plan, setPlan] = useState<ExportPlan>();
  const [running, setRunning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => { controller.current?.abort(); }, []);
  function finish() { setPlan(undefined); setRunning(false); setApplying(false); onBusy(false); }
  async function apply(next: ExportPlan, choices: Record<string, ExportChoice> = {}) {
    setApplying(true); setError("");
    try {
      const report = await applyMetadataExport(next, choices, controller.current?.signal);
      onResult(`导出完成：${exportSummary(report)}。目标目录：${next.root.name}`);
      finish();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (plan) { setError(message); setApplying(false); }
      else { onResult(message, true); finish(); }
    }
  }
  async function start() {
    controller.current = new AbortController();
    setRunning(true); onBusy(true); setError(""); onResult("");
    // Freeze the saved selection before the directory picker and any refresh.
    const saved = structuredClone(pages);
    try {
      const root = await window.showDirectoryPicker({ id: "localmark-metadata-export", mode: "readwrite" });
      const next = await prepareMetadataExport(root, saved, controller.current.signal);
      if (next.records.some(record => record.kind === "conflict")) setPlan(next);
      else await apply(next);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") onResult("已取消导出。");
      else onResult(e instanceof Error ? e.message : String(e), true);
      finish();
    }
  }
  return <>
    <button disabled={disabled || running} title="导出到文件夹；相同内容跳过，有差异时选择保留新文件或旧文件" onClick={() => void start()}>
      {plan ? "等待选择…" : running ? "正在导出…" : "导出所选网页"}
    </button>
    {plan && <ExportConflicts plan={plan} busy={applying} error={error} apply={choices => void apply(plan, choices)} cancel={() => {
      onResult(error || "已取消导出，文件未写入。", !!error); finish();
    }} />}
  </>;
}

function ExportConflicts({ plan, busy, error, apply, cancel }: {
  plan: ExportPlan; busy: boolean; error: string; apply: (choices: Record<string, ExportChoice>) => void; cancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [choices, setChoices] = useState<Record<string, ExportChoice>>({});
  const [checked, setChecked] = useState<string[]>([]);
  const conflicts = useMemo(() => plan.records.filter(record => record.kind === "conflict")
    .map(record => ({ ...record, differences: metadataDifferences(record) })), [plan]);
  const newCount = plan.records.filter(record => record.kind === "create").length;
  const sameCount = plan.records.filter(record => record.kind === "same").length;
  const remaining = conflicts.filter(record => !choices[record.path]).length;
  useEffect(() => { dialog.current?.showModal(); }, []);
  function choose(paths: string[], choice: ExportChoice) {
    setChoices(old => ({ ...old, ...Object.fromEntries(paths.map(path => [path, choice])) }));
  }
  const allPaths = conflicts.map(record => record.path);
  return createPortal(<dialog ref={dialog} className="export-conflicts" aria-label="处理导出冲突" onCancel={e => { e.preventDefault(); if (!busy) cancel(); }}>
    <header><div><h2>处理导出冲突</h2><p>目标文件夹：{plan.root.name}</p></div><button disabled={busy} onClick={cancel} aria-label="取消导出">取消</button></header>
    <p className="export-overview">{newCount} 个新文件 · {sameCount} 个内容相同，自动跳过 · {conflicts.length} 个冲突</p>
    <p className="export-explanation">新文件是本次导出的网页记录，旧文件是目标文件夹里的记录。用新文件会完整替换对应旧文件；用旧文件会保留原内容。全部选择完成后才开始写入。</p>
    <fieldset disabled={busy} className="export-decisions">
      <div className="export-batch">
        <div className="row wrap"><button onClick={() => setChecked(checked.length === conflicts.length ? [] : allPaths)}>{checked.length === conflicts.length ? "取消全选冲突" : "全选冲突"}</button><span>已勾选 {checked.length} 个</span>
          <button disabled={!checked.length} onClick={() => choose(checked, "new")}>勾选项用新文件</button><button disabled={!checked.length} onClick={() => choose(checked, "old")}>勾选项用旧文件</button></div>
        <div className="row wrap"><button onClick={() => choose(allPaths, "new")}>全部用新文件</button><button onClick={() => choose(allPaths, "old")}>全部用旧文件</button></div>
      </div>
      <div className="export-conflict-list">{conflicts.map((record, index) => <article className="export-conflict" key={record.path} data-path={record.path}>
        <div className="export-conflict-heading"><label><input type="checkbox" aria-label={`批量选择冲突：${record.path}`} checked={checked.includes(record.path)} onChange={() => setChecked(old => old.includes(record.path) ? old.filter(path => path !== record.path) : [...old, record.path])} /><strong>{record.page.title}</strong></label>
          <span className={`export-choice-state ${choices[record.path] ?? ""}`}>{choices[record.path] === "new" ? "将用新文件" : choices[record.path] === "old" ? "将保留旧文件" : "待选择"}</span></div>
        <p className="export-file-path">{record.path}</p>
        {record.destination !== record.path && <p className="export-file-path">用新文件后：{record.destination}（同步网页 ID）</p>}
        <p className="export-page-url">{record.page.url}</p>
        <div className="export-file-choices" role="group" aria-label={`文件选择：${record.path}`}>
          <label><input type="radio" name={`export-choice-${index}`} checked={choices[record.path] === "old"} onChange={() => choose([record.path], "old")} />用旧文件</label>
          <label><input type="radio" name={`export-choice-${index}`} checked={choices[record.path] === "new"} onChange={() => choose([record.path], "new")} />用新文件</label>
        </div>
        <details open={index === 0}><summary>查看 {record.differences.length} 处冲突内容</summary>
          <div className="export-differences">{record.differences.map((diff, i) => <section key={i} className="export-difference"><h3>{diff.label}</h3>
            <div className="export-comparison"><div><b>旧文件</b><pre tabIndex={0} aria-label={`${diff.label} · 旧文件`}>{diff.oldValue}</pre></div><div><b>新文件</b><pre tabIndex={0} aria-label={`${diff.label} · 新文件`}>{diff.newValue}</pre></div></div>
          </section>)}</div>
        </details>
      </article>)}</div>
    </fieldset>
    <footer><div role="status">{remaining ? `还有 ${remaining} 个冲突未选择` : "所有冲突已选择"}</div>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="row wrap"><button disabled={busy} onClick={cancel}>取消导出</button><button className="primary" disabled={busy || !!remaining} onClick={() => apply(choices)}>{busy ? "正在写入…" : "确认并导出"}</button></div>
    </footer>
  </dialog>, document.body);
}
