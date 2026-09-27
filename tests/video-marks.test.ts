import { describe, expect, it } from "vitest";
import { PageSchema, VideoMarkSchema } from "../src/model";
import { cueForTime, markCueRange, videoCueRef, videoPageUrl } from "../src/video-marks";

const cues = [
  { start: 0, end: 2, text: "First sentence" },
  { start: 4, end: 7, text: "Second sentence" },
  { start: 7, end: 11, text: "Third sentence" },
];
const now = "2026-09-27T00:00:00.000Z";
const mark = VideoMarkSchema.parse({ id: "00000000-0000-4000-8000-000000000001", kind: "subtitle",
  videoKey: "youtube:first", time: 0, trackId: "en", from: videoCueRef(cues[0], 0), to: videoCueRef(cues[1], 1),
  text: "First sentence Second sentence", note: "test", color: "yellow", createdAt: now, updatedAt: now });

describe("video annotation anchors", () => {
  it("attaches time points to the covering sentence or the preceding sentence in a gap", () => {
    expect([0, 2, 3, 4, 7, 20].map(time => cueForTime(cues, time))).toEqual([0, 0, 0, 1, 2, 2]);
  });
  it("highlights complete subtitle cues only in the source language and avoids guessed matches", () => {
    expect(markCueRange(mark, cues, "en")).toEqual([0, 1]);
    expect(markCueRange(mark, cues, "zh")).toBeNull();
    expect(markCueRange(mark, [{ ...cues[0], text: "changed" }, ...cues.slice(1)], "en")).toBeNull();
    expect(markCueRange(mark, [{ start: 0, end: 1, text: "intro" }, ...cues], "en")).toEqual([1, 2]);
  });
  it("validates screenshot paths and retains v4 marks in the page schema", () => {
    const screenshot = { ...mark, kind: "screenshot", time: 5.125, trackId: undefined, from: undefined, to: undefined,
      imagePath: "media/0123456789abcdef/00000000-0000-4000-8000-000000000001.png" };
    expect(VideoMarkSchema.parse(screenshot).time).toBe(5.125);
    expect(() => VideoMarkSchema.parse({ ...screenshot, imagePath: "../outside.png" })).toThrow();
    const page = PageSchema.parse({ schemaVersion: 4, id: "0123456789abcdef", url: "https://www.youtube.com/watch?v=first",
      originalUrl: "https://www.youtube.com/watch?v=first", title: "Video", favicon: "",
      folderName: "Video--0123456789abcdef", createdAt: now, updatedAt: now,
      annotations: [], videoMarks: [mark], category: "未分类", categoryId: "category:uncategorized", tagIds: [] });
    expect(page.videoMarks).toEqual([mark]);
    expect(() => PageSchema.parse({ ...page, schemaVersion: 3 })).toThrow();
  });
  it("normalizes watch and part URLs", () => {
    expect(videoPageUrl({ site: "youtube", key: "youtube:first" })).toBe("https://www.youtube.com/watch?v=first");
    expect(videoPageUrl({ site: "bilibili", key: "bilibili:BVtest:2" })).toBe("https://www.bilibili.com/video/BVtest/?p=2");
  });
});
