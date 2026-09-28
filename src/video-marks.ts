import type { Page, VideoCueRef, VideoMark } from "./model";
import type { SubtitleCue, VideoTarget } from "./video-transcript";

export function videoMarkLabel(kind: VideoMark["kind"]): string {
  return kind === "subtitle" ? "字幕标注" : kind === "screenshot" ? "截图" : kind === "comment" ? "视频评论" : "关键帧";
}

export function videoPageUrl(target: VideoTarget): string {
  const parts = target.key.split(":");
  if (target.site === "youtube") return `https://www.youtube.com/watch?v=${encodeURIComponent(parts[1])}`;
  if (target.site === "bilibili") return `https://www.bilibili.com/video/${encodeURIComponent(parts[1])}/?p=${Number(parts[2]) || 1}`;
  return `https://www.gdcvault.com/play/${encodeURIComponent(parts[1])}`;
}

export function videoCueRef(cue: SubtitleCue, index: number): VideoCueRef {
  return { index, start: cue.start, end: cue.end, text: cue.text };
}

export function cueForTime(cues: SubtitleCue[], time: number): number {
  if (!cues.length || !Number.isFinite(time)) return -1;
  const containing = cues.findIndex(cue => !!cue && cue.start <= time && time < cue.end);
  if (containing >= 0) return containing;
  for (let index = cues.length - 1; index >= 0; index--)
    if (cues[index] && cues[index].start <= time) return index;
  return cues.findIndex(Boolean);
}

function exactCue(cues: SubtitleCue[], ref: VideoCueRef): number {
  const valid = (cue: SubtitleCue | undefined) => !!cue && cue.start === ref.start && cue.end === ref.end && cue.text === ref.text;
  if (valid(cues[ref.index])) return ref.index;
  return cues.findIndex(valid);
}

export function markCueRange(mark: VideoMark, cues: SubtitleCue[], trackId: string): [number, number] | null {
  if (mark.kind !== "subtitle") {
    const index = cueForTime(cues, mark.time);
    return index < 0 ? null : [index, index];
  }
  if (mark.trackId !== trackId || !mark.from || !mark.to) return null;
  const from = exactCue(cues, mark.from), to = exactCue(cues, mark.to);
  return from >= 0 && to >= from ? [from, to] : null;
}

export function videoMarksForPage(page: Page | undefined, key: string): VideoMark[] {
  return page?.videoMarks?.filter(mark => mark.videoKey === key) ?? [];
}

export function screenshotsForMark(page: Page, mark: VideoMark): VideoMark[] {
  const shots = (page.videoMarks ?? []).filter(item => item.kind === "screenshot" && item.videoKey === mark.videoKey);
  if (mark.kind === "subtitle" && mark.from && mark.to)
    return shots.filter(item => mark.from!.start <= item.time && item.time <= mark.to!.end).sort((a, b) => a.time - b.time);
  if (mark.kind === "keyframe")
    return shots.filter(item => Math.abs(item.time - mark.time) < 0.05);
  if (mark.kind === "screenshot" && mark.from && mark.to)
    return shots.filter(item => mark.from!.start <= item.time && item.time <= mark.to!.end).sort((a, b) => a.time - b.time);
  return mark.kind === "screenshot"
    ? shots.filter(item => item.text === mark.text && Math.abs(item.time - mark.time) < 0.25).sort((a, b) => a.time - b.time)
    : [];
}

export function videoMarkLink(page: Page, mark: VideoMark): string {
  const url = new URL(page.url);
  if (mark.videoKey.startsWith("gdcvault:")) url.hash = `localmark-time=${mark.time}`;
  else url.searchParams.set("t", String(Math.floor(mark.time)));
  return url.href;
}
