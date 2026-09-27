import { afterEach, describe, expect, it, vi } from "vitest";
import {
  transcriptInterval,
  transcriptParagraphs,
  transcriptSeparator,
  watchTranscriptInterval,
  TRANSCRIPT_INTERVAL_KEY,
} from "../src/transcript-layout";
const items = (times: number[]) =>
  times.map((start, index) => ({
    index,
    cue: { start, end: start + 4, text: `Sentence ${index}` },
  }));
afterEach(() => vi.unstubAllGlobals());
describe("transcript paragraphs", () => {
  it("defaults to 30 seconds and rejects corrupt or out of range preferences", () => {
    for (const value of [undefined, null, "60", 0, -1, 2.5, 601, Infinity, NaN])
      expect(transcriptInterval(value)).toBe(30);
    expect(transcriptInterval(1)).toBe(1);
    expect(transcriptInterval(600)).toBe(600);
  });
  it("groups by source start time without splitting, retiming, or dropping a boundary-spanning cue", () => {
    const input = items([3, 28, 29.999, 30, 59, 60, 121]);
    const result = transcriptParagraphs(input, 30);
    expect(result.map((g) => g.items.map((i) => i.index))).toEqual([
      [0, 1, 2],
      [3, 4],
      [5],
      [6],
    ]);
    expect(result.flatMap((g) => g.items)).toEqual(input);
    expect(result[0].items[2].cue.end).toBeCloseTo(33.999);
    expect(transcriptParagraphs(input, 60).map((g) => g.items.length)).toEqual([
      5, 1, 1,
    ]);
  });
  it("keeps original cue indexes and buckets when search filters out neighboring sentences", () => {
    const input = items([0, 15, 31, 50, 65]).filter(
      (i) => i.index === 1 || i.index === 3,
    );
    expect(
      transcriptParagraphs(input, 30).map((g) => [g.bucket, g.items[0].index]),
    ).toEqual([
      [0, 1],
      [1, 3],
    ]);
    expect(transcriptParagraphs([], 30)).toEqual([]);
  });
  it("joins Latin fragments with a space while keeping Chinese text continuous", () => {
    expect(transcriptSeparator("hello", "world")).toBe(" ");
    expect(transcriptSeparator("这是", "字幕")).toBe("");
    expect(transcriptSeparator("字", "，继续")).toBe("");
  });
  it("applies live setting changes before a delayed initial read and handles a reset", async () => {
    let read!: (v: object) => void, change!: (c: object, area: string) => void;
    const remove = vi.fn(),
      update = vi.fn();
    vi.stubGlobal("chrome", {
      storage: {
        local: { get: () => new Promise((r) => (read = r)) },
        onChanged: {
          addListener: (f: typeof change) => (change = f),
          removeListener: remove,
        },
      },
    });
    const dispose = watchTranscriptInterval(update);
    change({ [TRANSCRIPT_INTERVAL_KEY]: { newValue: 15 } }, "local");
    read({ [TRANSCRIPT_INTERVAL_KEY]: 60 });
    await Promise.resolve();
    expect(update.mock.calls).toEqual([[15]]);
    change({ [TRANSCRIPT_INTERVAL_KEY]: { newValue: undefined } }, "local");
    expect(update).toHaveBeenLastCalledWith(30);
    dispose();
    expect(remove).toHaveBeenCalledWith(change);
  });
});
