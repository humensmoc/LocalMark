import { isGeneratedMarkdown, type Entry } from "./model";
import type { DirectoryFiles } from "./files";

type PageFiles = Pick<DirectoryFiles, "read" | "write" | "remove" | "readBlob" | "writeBlob">;

export async function deletePageData(entry: Entry, files: PageFiles, commit: () => Promise<void>) {
  if (entry.issue || entry.dirty || entry.mdDirty)
    throw Error("此网页仍有待同步或冲突，请先处理底部同步状态后重试。");
  const id = entry.page.id;
  const jsonPath = `data/${id}.json`;
  const json = await files.read(jsonPath);
  if (json !== entry.baseJson) throw Error("本地 JSON 已改变，请刷新并核对后重试。");
  const mdPath = entry.page.markdownFile ?? `${entry.page.folderName}/标注.md`;
  const md = await files.read(mdPath);
  if (md !== null && md !== entry.baseMd && !isGeneratedMarkdown(md, entry.page))
    throw Error("对应 Markdown 有手工修改，请先备份或移走该文件后重试。");
  const images = [] as { path: string; data: Blob }[];
  for (const mark of [...entry.page.annotations, ...(entry.page.videoMarks ?? [])]) {
    if (!mark.imagePath) continue;
    if (!new RegExp(`^media/${id}/[a-f0-9-]+\\.png$`).test(mark.imagePath))
      throw Error("截图文件路径异常，已暂停删除。");
    if (images.some(image => image.path === mark.imagePath)) continue;
    const data = await files.readBlob(mark.imagePath);
    if (data) images.push({ path: mark.imagePath, data });
  }
  const removed: { path: string; value: string | Blob }[] = [];
  try {
    for (const image of images) {
      removed.push({ path: image.path, value: image.data });
      await files.remove(image.path);
    }
    if (md !== null) {
      removed.push({ path: mdPath, value: md });
      await files.remove(mdPath);
    }
    if (json !== null) {
      removed.push({ path: jsonPath, value: json });
      await files.remove(jsonPath);
    }
    await commit();
  } catch (error) {
    const failures: string[] = [];
    for (const item of removed.reverse()) {
      try {
        if (typeof item.value === "string") await files.write(item.path, item.value);
        else await files.writeBlob(item.path, item.value);
      } catch (restoreError) { failures.push(String(restoreError)); }
    }
    if (failures.length) throw Error(`删除未完成，文件恢复失败：${failures.join("；")}；原错误：${String(error)}`);
    throw error;
  }
}
