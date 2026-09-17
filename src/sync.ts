import {
  type Library,
  type Entry,
  markdown,
  isGeneratedMarkdown,
  previousMarkdown,
  markdownFileName,
  parsePage,
} from "./model";
import type { Files } from "./files";
const rawPath = (id: string) => `原始数据/${id}.json`;
const mdPath = (e: Entry) =>
  e.page.markdownFile ?? `${e.page.folderName}/标注.md`;
const serialize = (e: Entry) => JSON.stringify(e.page, null, 2) + "\n";
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
export class SyncEngine {
  constructor(
    public lib: Library,
    private files: Files,
    private persist: () => Promise<void>,
  ) {}
  private async refresh(ids?: ReadonlySet<string>) {
    const names = ids ? [...ids].map((id) => `${id}.json`) : await this.files.listJson();
    this.lib.errors = ids
      ? this.lib.errors.filter((error) => !names.some((name) => error.startsWith(`${name}：`)))
      : [];
    const seen = new Set<string>();
    for (const name of names) {
      const id = name.slice(0, -5);
      seen.add(id);
      const current = this.lib.entries[id];
      try {
        const raw = await this.files.read(`原始数据/${name}`);
        if (raw === null) {
          seen.delete(id);
          continue;
        }
        const p = await parsePage(raw, id);
        const legacy = !Array.isArray(JSON.parse(raw).tags);
        const migrate = legacy || JSON.parse(raw).category === undefined;
        if (!current) {
          this.lib.entries[id] = {
            page: p,
            baseJson: raw,
            baseMd: p.markdownFile ? markdown(p) : previousMarkdown(p, legacy),
            dirty: migrate,
            mdDirty: true,
          };
          continue;
        }
        if (raw === current.baseJson) {
          if (migrate) current.dirty = current.mdDirty = true;
          if (
            current.issue?.kind === "invalid" ||
            current.issue?.kind === "missing"
          )
            delete current.issue;
          continue;
        }
        if (current.dirty) {
          current.issue = {
            kind: "json",
            message: "本地 JSON 与浏览器待保存版本同时修改，请选择保留版本。",
            external: raw,
          };
          continue;
        }
        if (current.page.folderName !== p.folderName) {
          current.issue = {
            kind: "invalid",
            message: "请保留 JSON 中的 folderName，避免重复生成目录。",
            external: raw,
          };
          continue;
        }
        if (
          current.page.markdownFile &&
          current.page.markdownFile !== p.markdownFile
        ) {
          current.issue = {
            kind: "invalid",
            message: "请保留 JSON 中的 markdownFile，避免重复导出。",
            external: raw,
          };
          continue;
        }
        current.page = p;
        current.baseJson = raw;
        current.dirty = migrate;
        current.mdDirty = true;
        delete current.issue;
      } catch (error) {
        const message = `${name}：${errorText(error)}`;
        this.lib.errors.push(message);
        if (current) current.issue = { kind: "invalid", message };
      }
    }
    for (const [id, e] of Object.entries(this.lib.entries))
      if ((!ids || ids.has(id)) && e.baseJson !== null && !seen.has(id))
        e.issue = {
          kind: "missing",
          message:
            "本地 JSON 已被移走或删除。可恢复浏览器版本，或接受文件删除。",
        };
  }
  async run(ids?: ReadonlySet<string>) {
    await this.refresh(ids);
    for (const [id, e] of Object.entries(this.lib.entries)) {
      if (ids && !ids.has(id)) continue;
      if (e.issue && e.issue.kind !== "io" && e.issue.kind !== "markdown")
        continue;
      try {
        if (!e.page.markdownFile) {
          const oldPath = mdPath(e);
          const old = await this.files.read(oldPath);
          if (
            old !== null &&
            old !== e.baseMd &&
            !isGeneratedMarkdown(old, e.page)
          ) {
            e.issue = {
              kind: "markdown",
              message: "旧 Markdown 有手工改动，请先备份处理后再迁移。",
              external: old,
            };
            continue;
          }
          let candidate = markdownFileName(e.page.title);
          for (let n = 0; ; n++) {
            const occupied = Object.values(this.lib.entries).some(
              (other) =>
                other !== e &&
                other.page.markdownFile?.toLocaleLowerCase() ===
                  candidate.toLocaleLowerCase(),
            );
            const existing = await this.files.read(candidate);
            if (
              !occupied &&
              (existing === null ||
                isGeneratedMarkdown(existing, e.page))
            )
              break;
            candidate = markdownFileName(
              e.page.title,
              `--${id}${n ? "-" + n : ""}`,
            );
          }
          e.page.markdownFile = candidate;
          e.legacyMdPath = oldPath;
          e.legacyMdBase = old;
          e.dirty = e.mdDirty = true;
          await this.persist();
        }
        if (e.dirty) {
          const current = await this.files.read(rawPath(id));
          if (current !== e.baseJson) {
            e.issue = {
              kind: "json",
              message: "写入前发现 JSON 已改变，已暂停覆盖。",
              external: current ?? undefined,
            };
            continue;
          }
          const value = serialize(e);
          await this.files.write(rawPath(id), value);
          e.baseJson = value;
          e.dirty = false;
          e.mdDirty = true;
          await this.persist();
        }
        // Check even clean Markdown on refresh, so manual edits cannot be silently adopted.
        const intended = markdown(e.page),
          current = await this.files.read(mdPath(e));
        if (current !== null && current !== e.baseMd && !isGeneratedMarkdown(current, e.page)) {
          e.issue = {
            kind: "markdown",
            message: "Markdown 有手工改动，已暂停覆盖；可备份后重新生成。",
            external: current,
          };
          continue;
        }
        if (current !== intended) await this.files.write(mdPath(e), intended);
        e.baseMd = intended;
        e.mdDirty = false;
        delete e.issue;
        if (e.legacyMdPath) {
          const old = await this.files.read(e.legacyMdPath);
          if (old !== null) {
            if (old !== e.legacyMdBase)
              throw Error(
                "新文档已保存，但旧 Markdown 又被修改，已保留旧文件，请手动核对。",
              );
            await this.files.remove(e.legacyMdPath);
          }
          delete e.legacyMdPath;
          delete e.legacyMdBase;
        }
      } catch (error) {
        e.issue = { kind: "io", message: "文件写入失败：" + errorText(error) };
      }
    }
    const pending = Object.values(this.lib.entries).filter(
      (e) => e.dirty || e.mdDirty || e.issue,
    ).length;
    this.lib.status =
      pending || this.lib.errors.length
        ? `${pending} 个网页待同步或需处理；${this.lib.errors.length} 个文件读取错误`
        : "已保存到本地文件";
    await this.persist();
  }
  async resolve(id: string, choice: "local" | "disk") {
    const e = this.lib.entries[id];
    if (!e?.issue) throw Error("此冲突已处理，请刷新。");
    const stamp =
      new Date().toISOString().replace(/[:.]/g, "-") +
      "-" +
      crypto.randomUUID().slice(0, 8);
    if (e.issue.kind === "markdown") {
      if (choice !== "local")
        throw Error("Markdown 仅提供备份后重新生成；关闭窗口即可继续保留。");
      const current = await this.files.read(mdPath(e));
      if (current !== null)
        await this.files.write(`冲突备份/${id}-${stamp}.md`, current);
      e.baseMd = current;
      e.mdDirty = true;
      delete e.issue;
      await this.persist();
      return this.run();
    }
    const current = await this.files.read(rawPath(id));
    // Always archive the losing version before accepting a destructive resolution.
    if (choice === "disk") {
      const p = current === null ? null : await parsePage(current, id);
      if (p && p.folderName !== e.page.folderName)
        throw Error("请先还原 folderName，再读回 JSON。");
      await this.files.write(
        `冲突备份/${id}-${stamp}-浏览器.json`,
        serialize(e),
      );
      if (p) {
        e.page = p;
        e.baseJson = current;
        e.dirty = false;
        e.mdDirty = true;
        delete e.issue;
      } else delete this.lib.entries[id];
    } else {
      if (current !== null)
        await this.files.write(`冲突备份/${id}-${stamp}-本地.json`, current);
      e.baseJson = current;
      e.dirty = true;
      e.mdDirty = true;
      delete e.issue;
    }
    await this.persist();
    return this.run();
  }
}
