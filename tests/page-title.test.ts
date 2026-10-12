// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PageTitle, type TitleDraft } from "../src/PageTitle";

const roots: Root[] = [];
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

it("saves the title when focus leaves the editor, but cancels without saving", async () => {
  const host = document.createElement("div");
  const outside = document.createElement("button");
  document.body.append(host, outside);
  const root = createRoot(host);
  roots.push(root);
  const draft: TitleDraft = { value: "修改后的标题", base: "原标题" };
  const save = vi.fn(async () => {});
  const cancel = vi.fn();
  await act(async () => root.render(createElement(PageTitle, {
    title: "原标题", savedTitle: "原标题", draft, change: vi.fn(), cancel, save,
  })));
  const input = host.querySelector("textarea")!;
  await act(async () => { input.focus(); outside.focus(); });
  expect(save).toHaveBeenCalledOnce();
  expect(save).toHaveBeenCalledWith(draft);

  save.mockClear();
  await act(async () => { input.focus(); host.querySelector<HTMLButtonElement>("button:not(.primary)")!.focus(); });
  expect(save).not.toHaveBeenCalled();
  await act(async () => host.querySelector<HTMLButtonElement>("button:not(.primary)")!.click());
  expect(cancel).toHaveBeenCalledOnce();
  expect(save).not.toHaveBeenCalled();
});

it("keeps a stale title draft instead of overwriting a newer title on blur", async () => {
  const host = document.createElement("div");
  const outside = document.createElement("button");
  document.body.append(host, outside);
  const root = createRoot(host);
  roots.push(root);
  const save = vi.fn(async () => {});
  await act(async () => root.render(createElement(PageTitle, {
    title: "新标题", savedTitle: "新标题",
    draft: { value: "我的草稿", base: "旧标题" }, change: vi.fn(), cancel: vi.fn(), save,
  })));
  await act(async () => { host.querySelector("textarea")!.focus(); outside.focus(); });
  expect(save).not.toHaveBeenCalled();
  expect(host.querySelector("[role=alert]")?.textContent).toContain("标题已有更新");
});
