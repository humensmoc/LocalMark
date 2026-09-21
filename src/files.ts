import { listMetadataFiles, metadataFileId, metadataFilePath } from "./metadata-names";

export interface Files {
  // JSON paths in the sync engine use stable IDs; the disk adapter resolves titles.
  read(path: string): Promise<string | null>;
  write(path: string, value: string): Promise<void>;
  listJson(): Promise<string[]>;
  remove(path: string): Promise<void>;
  prepareJsonFile?(id: string, title: string, createdAt: string, expected: string | null): Promise<void>;
}
export class DirectoryFiles implements Files {
  constructor(private root: FileSystemDirectoryHandle) {}
  private jsonNames: Map<string, string[]> | undefined;
  private async indexJson() {
    const entries = await listMetadataFiles(this.root);
    this.jsonNames = new Map();
    for (const { name, path } of entries) {
      const id = metadataFileId(name);
      if (id) this.jsonNames.set(id, [...(this.jsonNames.get(id) ?? []), path]);
    }
    return entries;
  }
  private async namesFor(id: string) {
    if (!this.jsonNames) await this.indexJson();
    return this.jsonNames!.get(id) ?? [];
  }
  async prepareJsonFile(id: string, title: string, createdAt: string, expected: string | null) {
    if (!/^[a-f0-9]{16}$/.test(id)) throw Error("无效网页 ID");
    const target = metadataFilePath(title, id, createdAt);
    const existingNames = await this.namesFor(id);
    if (existingNames.length === 1 && existingNames[0] === target) return;
    const names = [...new Set([...existingNames, target])];
    // Check every alias before copying or removing anything. Interrupted copies with
    // identical bytes can be retried; divergent duplicates require manual review.
    for (const name of names) {
      const value = await this.readFile(name);
      if (value !== null && value !== expected)
        throw Error(`元数据文件 ${name} 已改变，已暂停改名，请刷新后核对。`);
    }
    const old = await this.read(`data/${id}.json`);
    if (old !== expected) throw Error("元数据文件已改变或被移走，已暂停改名。");
    this.jsonNames!.set(id, names);
    if (expected !== null) {
      const path = target;
      if (await this.readFile(path) === null) await this.writeFile(path, expected);
      if (await this.readFile(path) !== expected)
        throw Error("新元数据文件校验失败，已保留旧文件。");
      for (const name of names) {
        if (name === target) continue;
        const value = await this.readFile(name);
        if (value === null) continue;
        if (value !== expected)
          throw Error(`旧元数据文件 ${name} 在改名期间被修改，已保留两份文件，请核对。`);
        if (await this.readFile(path) !== expected)
          throw Error("新元数据文件在改名期间被修改，已保留旧文件，请核对。");
        await this.removeFile(name);
      }
    }
    this.jsonNames!.set(id, [target]);
  }
  private async parent(path: string, create = false) {
    const parts = path.split("/");
    let dir = this.root;
    for (const part of parts.slice(0, -1)) {
      if (!part || part === "." || part === "..") throw Error("无效文件路径");
      try {
        dir = await dir.getDirectoryHandle(part, { create });
      } catch (error) {
        // Older exports included invisible title formatting in folderName.
        // Chromium can reject those names even when just checking existence.
        // Enumerate the exact legacy name before deciding it is absent; never
        // sanitize a read path into a different, potentially unrelated folder.
        if (create || !/\p{Cf}/u.test(part) || !(error instanceof TypeError))
          throw error;
        let legacy: FileSystemDirectoryHandle | undefined;
        for await (const [name, handle] of dir.entries()) {
          if (name !== part) continue;
          if (handle.kind !== "directory") throw error;
          legacy = handle;
          break;
        }
        if (!legacy) throw new DOMException("旧目录不存在", "NotFoundError");
        dir = legacy;
      }
    }
    return { dir, name: parts.at(-1)! };
  }
  // Exact paths are also used by reviewed exports, without stable-ID alias lookup.
  async readFile(path: string) {
    try {
      const { dir, name } = await this.parent(path);
      const file = await (await dir.getFileHandle(name)).getFile();
      if (file.size > 32_000_000) throw Error("文件超过 32 MB");
      return await file.text();
    } catch (e) {
      if (e instanceof DOMException && e.name === "NotFoundError") return null;
      throw e;
    }
  }
  async read(path: string) {
    const id = /^data\/([a-f0-9]{16})\.json$/.exec(path)?.[1];
    if (!id) return this.readFile(path);
    let result: string | null = null;
    for (const name of await this.namesFor(id)) {
      const value = await this.readFile(name);
      if (value === null) continue;
      if (result !== null && value !== result)
        throw Error(`网页 ${id} 有内容不同的多个 JSON，请核对并将多余版本移出 data 和旧原始数据目录。`);
      result = value;
    }
    return result;
  }
  async writeFile(path: string, value: string) {
    const { dir, name } = await this.parent(path, true);
    const file = await dir.getFileHandle(name, { create: true });
    const writer = await file.createWritable();
    try {
      await writer.write(value);
      await writer.close();
    } catch (e) {
      try {
        await writer.abort();
      } catch {}
      throw e;
    }
  }
  async write(path: string, value: string) {
    const id = /^data\/([a-f0-9]{16})\.json$/.exec(path)?.[1];
    if (id) {
      const names = await this.namesFor(id);
      if (names.length !== 1) throw Error("元数据存在多个版本，已暂停写入，请刷新后核对。");
      path = names[0];
    }
    await this.writeFile(path, value);
  }
  async listJson() {
    const names = await this.indexJson();
    return [...new Set(names.map(({ name, path }) => {
      const id = metadataFileId(name);
      return id ? `${id}.json` : path;
    }))];
  }
  async removeFile(path: string) {
    const { dir, name } = await this.parent(path);
    await dir.removeEntry(name);
    const parts = path.split("/");
    for (let depth = parts.length - 1; depth > 0; depth--) {
      // Never remove a non-empty directory or its unrelated contents.
      try {
        const parent = await this.parent(parts.slice(0, depth).join("/"));
        await parent.dir.removeEntry(parent.name);
      } catch (e) {
        // The migrated file is gone; Chromium may still reject the legacy
        // directory name during optional empty-directory cleanup.
        if (e instanceof TypeError && /\p{Cf}/u.test(parts[depth - 1])) return;
        if (e instanceof DOMException && e.name === "InvalidModificationError") return;
        if (!(e instanceof DOMException && e.name === "NotFoundError")) throw e;
      }
    }
  }
  async remove(path: string) {
    const id = /^data\/([a-f0-9]{16})\.json$/.exec(path)?.[1];
    if (id) {
      const names = await this.namesFor(id);
      if (names.length !== 1) throw Error("元数据存在多个版本，已暂停删除，请核对。");
      path = names[0];
    }
    await this.removeFile(path);
  }
}
