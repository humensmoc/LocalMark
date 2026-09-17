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
      dir = await dir.getDirectoryHandle(part, { create });
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
        if (!(
          e instanceof DOMException && e.name === "InvalidModificationError"
        ))
          throw e;
      }
    }
  }
}
