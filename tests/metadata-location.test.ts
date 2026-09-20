import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as db from "../src/db";
import { locateMetadata, openMetadataLocation } from "../src/metadata-location";

vi.mock("../src/db", () => ({ get: vi.fn() }));
const id = "0123456789abcdef";
const file = { name: `${id}.json`, kind: "file", getFile: vi.fn() };
const directory = { getFileHandle: vi.fn(), entries: vi.fn() };
const root = { name: "我的摘录", queryPermission: vi.fn(), getDirectoryHandle: vi.fn() };

beforeEach(() => {
  vi.mocked(db.get).mockResolvedValue(root);
  root.queryPermission.mockResolvedValue("granted");
  root.getDirectoryHandle.mockImplementation(async name => {
    if (name === "原始数据") return directory;
    throw new DOMException("missing", "NotFoundError");
  });
  directory.getFileHandle.mockResolvedValue(file);
  directory.entries.mockImplementation(async function* () { yield [file.name, file]; });
  file.getFile.mockResolvedValue({});
});
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });

it("finds the current page's JSON without creating directories or files", async () => {
  const location = await locateMetadata(id);
  expect(location.path).toBe(`我的摘录/原始数据/${id}.json`);
  expect(location.file).toBe(file);
  expect(root.getDirectoryHandle).toHaveBeenCalledWith("原始数据");
  expect(directory.getFileHandle).toHaveBeenCalledWith(`${id}.json`);
  expect(file.getFile).toHaveBeenCalledOnce();
});

it("refuses a disconnected or unauthorized folder without requesting write access", async () => {
  vi.mocked(db.get).mockResolvedValueOnce(undefined);
  await expect(locateMetadata(id)).rejects.toThrow("连接本地文件夹");
  root.queryPermission.mockResolvedValue("denied");
  await expect(locateMetadata(id)).rejects.toThrow("重新授权");
  expect(root.queryPermission).toHaveBeenCalledWith({ mode: "read" });
  expect(root.getDirectoryHandle).not.toHaveBeenCalled();
});

it.each(["directory", "file", "deleted handle"])("reports missing %s instead of creating an empty metadata file", async stage => {
  const failure = new DOMException("missing", "NotFoundError");
  if (stage === "directory") root.getDirectoryHandle.mockRejectedValue(failure);
  else if (stage === "file") directory.getFileHandle.mockRejectedValue(failure);
  else file.getFile.mockRejectedValue(failure);
  await expect(locateMetadata(id)).rejects.toThrow("尚未生成或已移走");
});

it("rejects invalid article IDs before accessing the filesystem", async () => {
  await expect(locateMetadata("../other")).rejects.toThrow("无法识别");
  expect(db.get).not.toHaveBeenCalled();
});

it("uses the readable name on disk and refuses ambiguous duplicates", async () => {
  const name = `测试文章--${id}.json`;
  directory.entries.mockImplementation(async function* () { yield [name, file]; });
  expect((await locateMetadata(id)).fileName).toBe(name);
  expect(directory.getFileHandle).toHaveBeenLastCalledWith(name);
  directory.entries.mockImplementation(async function* () { yield [name, file]; yield [file.name, file]; });
  await expect(locateMetadata(id)).rejects.toThrow("多个元数据文件");
});

it("locates the actual file inside month and day folders", async () => {
  const day = directory;
  const month = { entries: async function* () { yield ["20", { kind: "directory", ...day }]; } };
  const data = { entries: async function* () { yield ["2026-09", { kind: "directory", ...month }]; } };
  root.getDirectoryHandle.mockImplementation(async name => {
    if (name === "data") return data;
    throw new DOMException("missing", "NotFoundError");
  });
  expect((await locateMetadata(id)).path).toBe(`我的摘录/data/2026-09/20/${id}.json`);
});

it("starts at the exact file handle and does not import or modify a selection", async () => {
  const selected = { getFile: vi.fn(), createWritable: vi.fn() };
  const picker = vi.fn().mockResolvedValue([selected]);
  vi.stubGlobal("window", { showOpenFilePicker: picker });
  await openMetadataLocation(await locateMetadata(id));
  expect(picker).toHaveBeenCalledWith(expect.objectContaining({ startIn: file, multiple: false }));
  expect(selected.getFile).not.toHaveBeenCalled();
  expect(selected.createWritable).not.toHaveBeenCalled();
});

it("treats cancellation as normal while exposing unsupported browsers and real failures", async () => {
  const location = await locateMetadata(id);
  const picker = vi.fn().mockRejectedValue(new DOMException("cancel", "AbortError"));
  vi.stubGlobal("window", { showOpenFilePicker: picker });
  await expect(openMetadataLocation(location)).resolves.toBeUndefined();
  picker.mockRejectedValue(new DOMException("permission", "NotAllowedError"));
  await expect(openMetadataLocation(location)).rejects.toThrow("permission");
  vi.stubGlobal("window", {});
  await expect(openMetadataLocation(location)).rejects.toThrow("不支持");
});
