import { it, expect } from "vitest";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  readdir,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { SyncEngine } from "../src/sync";
import { emptyLibrary, pageId, folderName, type Page } from "../src/model";
import type { Files } from "../src/files";
it("round-trips a real Windows directory with per-page files and manual-edit protection", async () => {
  const root = await mkdtemp(join(tmpdir(), "web-clipper-files-"));
  const files: Files = {
    async remove(p) {
      await unlink(join(root, p));
    },
    async read(p) {
      try {
        return await readFile(join(root, p), "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw e;
      }
    },
    async write(p, s) {
      const target = join(root, p);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, s, "utf8");
    },
    async listJson() {
      try {
        return await readdir(join(root, "原始数据"));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw e;
      }
    },
  };
  const id = await pageId("https://example.com/real-disk"),
    now = new Date().toISOString();
  const page: Page = {
    schemaVersion: 1,
    category: "未分类",
    tags: ["测试"],
    id,
    url: "https://example.com/real-disk",
    originalUrl: "https://example.com/real-disk",
    title: "真实目录测试",
    folderName: folderName("真实目录测试", id),
    favicon: "",
    createdAt: now,
    updatedAt: now,
    annotations: [
      {
        id: crypto.randomUUID(),
        text: "real files",
        note: "本地批注",
        tags: ["测试"],
        color: "green",
        anchor: {
          exact: "real files",
          prefix: "",
          suffix: "",
          start: 0,
          end: 10,
        },
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
  const lib = emptyLibrary();
  lib.entries[id] = {
    page,
    baseJson: null,
    baseMd: null,
    dirty: true,
    mdDirty: true,
  };
  const engine = new SyncEngine(lib, files, async () => {});
  await engine.run();
  expect(lib.status).toBe("已保存到本地文件");
  const jsonPath = `原始数据/${id}.json`,
    mdPath = page.markdownFile!;
  const external = JSON.parse((await files.read(jsonPath))!);
  external.annotations[0].note = "文件系统中的修改";
  await files.write(jsonPath, JSON.stringify(external));
  await engine.run();
  expect(await files.read(mdPath)).toContain("文件系统中的修改");
  await files.write(mdPath, "人工写下的内容");
  await engine.run();
  expect(lib.entries[id].issue?.kind).toBe("markdown");
  expect(await files.read(mdPath)).toBe("人工写下的内容");
  await engine.resolve(id, "local");
  expect((await readdir(join(root, "冲突备份"))).length).toBe(1);
  expect(await files.read(mdPath)).toContain("文件系统中的修改");
}, 15000);
