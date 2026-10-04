import { describe, expect, it } from "vitest";
import { dualTranscriptMarkdown, transcriptMarkdown } from "../src/transcript-download";
import type { Transcript } from "../src/video-transcript";

const transcript: Transcript = {
  key: "youtube:abc",
  source: "YouTube · 原生内容转文字",
  tracks: [{ id: "native", label: "English" }],
  selected: "native",
  cues: [
    { start: 0.4, end: 2, text: "first line" },
    { start: 31.2, end: 33, text: "second\nline" },
  ],
};

describe("transcript Markdown download", () => {
  it("exports every original cue, including those outside the visible search result", () => {
    expect(transcriptMarkdown(transcript, "A video", "https://www.youtube.com/watch?v=abc"))
      .toBe("# A video\n\n- 视频：https://www.youtube.com/watch?v=abc\n- 来源：YouTube · 原生内容转文字\n\n## 字幕\n\n**0:00** first line\n\n**0:31** second line\n");
  });
  it("does not generate a misleading empty file", () => {
    expect(() => transcriptMarkdown({ ...transcript, cues: [] }, "A video", "https://example.com"))
      .toThrow("没有可下载的字幕");
  });
  it("keeps native and player sentences separate in one Markdown file", () => {
    const player = { ...transcript, source: "YouTube · 播放器字幕", cues: [
      { start: 1, end: 3, text: "different player sentence" },
    ] };
    const output = dualTranscriptMarkdown(transcript, player, "A video", "https://www.youtube.com/watch?v=abc");
    expect(output).toContain("## 内容转文字\n\n**0:00** first line");
    expect(output).toContain("## 播放器字幕\n\n**0:01** different player sentence");
    expect(output.match(/## /g)).toHaveLength(2);
    expect(() => dualTranscriptMarkdown(transcript, { ...player, cues: [] }, "A video", "https://example.com"))
      .toThrow("两个字幕来源未完整加载");
  });
});
