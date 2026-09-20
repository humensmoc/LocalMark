import * as db from "./db";
import { listMetadataFiles, metadataFileId } from "./metadata-names";

export type MetadataLocation = {
  file: FileSystemFileHandle;
  fileName: string;
  path: string;
};

export async function locateMetadata(pageId: string): Promise<MetadataLocation> {
  if (!/^[a-f0-9]{16}$/.test(pageId)) throw Error("无法识别当前文章的元数据文件。");
  const root = await db.get<FileSystemDirectoryHandle>("root");
  if (!root) throw Error("请先在底部设置中连接本地文件夹。");
  if ((await root.queryPermission({ mode: "read" })) !== "granted")
    throw Error("文件夹权限已失效，请在底部设置中重新授权。");
  try {
    const matches = (await listMetadataFiles(root)).filter(file => metadataFileId(file.name) === pageId);
    if (matches.length > 1) throw Error("文章存在多个元数据文件，请先刷新本地数据并处理重复文件。");
    if (!matches.length) throw new DOMException("文件不存在", "NotFoundError");
    const { directory, name: fileName, path } = matches[0];
    const file = await directory.getFileHandle(fileName);
    // Confirm the file exists on disk; browser-cached pages may still be pending sync.
    await file.getFile();
    return { file, fileName, path: `${root.name}/${path}` };
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError")
      throw Error("本地元数据文件尚未生成或已移走，请检查底部同步状态。");
    if (error instanceof DOMException && error.name === "NotAllowedError")
      throw Error("无法读取本地文件，请在底部设置中重新授权。");
    throw error;
  }
}

export async function openMetadataLocation(location: MetadataLocation) {
  if (typeof window.showOpenFilePicker !== "function")
    throw Error("当前浏览器不支持打开本地文件位置。");
  try {
    // Passing a file handle starts the native picker in that file's parent.
    // This is navigation only: never import the selection or open a writable stream.
    await window.showOpenFilePicker({
      startIn: location.file,
      multiple: false,
      types: [{ description: "文章元数据（JSON）", accept: { "application/json": [".json"] } }],
      excludeAcceptAllOption: true,
    });
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) throw error;
  }
}
