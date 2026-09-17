export interface Files {
  read(path: string): Promise<string | null>;
  write(path: string, value: string): Promise<void>;
  listJson(): Promise<string[]>;
  remove(path: string): Promise<void>;
}
export class DirectoryFiles implements Files {
  constructor(private root: FileSystemDirectoryHandle) {}
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
  async read(path: string) {
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
  async write(path: string, value: string) {
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
  async listJson() {
    try {
      const dir = await this.root.getDirectoryHandle("原始数据");
      const result: string[] = [];
      for await (const [name, handle] of dir.entries())
        if (handle.kind === "file" && name.endsWith(".json")) result.push(name);
      return result;
    } catch (e) {
      if (e instanceof DOMException && e.name === "NotFoundError") return [];
      throw e;
    }
  }
  async remove(path: string) {
    const { dir, name } = await this.parent(path);
    await dir.removeEntry(name);
    const parts = path.split("/");
    if (parts.length === 2) {
      // Never remove a non-empty directory or its unrelated contents.
      try {
        await this.root.removeEntry(parts[0]);
      } catch (e) {
        // The migrated file is gone; Chromium may still reject the legacy
        // directory name during optional empty-directory cleanup.
        if (e instanceof TypeError && /\p{Cf}/u.test(parts[0])) return;
        if (!(
          e instanceof DOMException && e.name === "InvalidModificationError"
        ))
          throw e;
      }
    }
  }
}
