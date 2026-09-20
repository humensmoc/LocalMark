import { folderName } from "./model";

export function metadataFileName(title: string, id: string) {
  return `${folderName(title, id)}.json`;
}

export function metadataFilePath(title: string, id: string, createdAt: string) {
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) throw Error("元数据的创建日期无效，无法归档。");
  const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  const day = String(date.getDate()).padStart(2, "0");
  return `data/${month}/${day}/${metadataFileName(title, id)}`;
}

// Both layouts are indexed by stable ID so existing collections remain readable
// during migration, including a copy interrupted between writing and cleanup.
export async function listMetadataFiles(root: FileSystemDirectoryHandle) {
  const result: { path: string; name: string; directory: FileSystemDirectoryHandle }[] = [];
  async function walk(directory: FileSystemDirectoryHandle, prefix: string) {
    for await (const [name, handle] of directory.entries()) {
      if (handle.kind === "directory") await walk(handle, `${prefix}/${name}`);
      else if (name.endsWith(".json")) result.push({ path: `${prefix}/${name}`, name, directory });
    }
  }
  for (const name of ["data", "原始数据"]) {
    let directory: FileSystemDirectoryHandle;
    try { directory = await root.getDirectoryHandle(name); }
    catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") continue;
      throw error;
    }
    await walk(directory, name);
  }
  return result;
}

// The stable suffix keeps same-title articles distinct and old ID-only exports readable.
export function metadataFileId(name: string) {
  return /^(?:[^/\\]+--)?([a-f0-9]{16})\.json$/.exec(name)?.[1];
}
