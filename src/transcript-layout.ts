import type { SubtitleCue } from "./video-transcript";

export const TRANSCRIPT_INTERVAL_KEY = "transcriptParagraphSeconds";
export const DEFAULT_TRANSCRIPT_INTERVAL = 30;
export function validTranscriptInterval(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 600
  );
}
export function transcriptInterval(value: unknown) {
  return validTranscriptInterval(value) ? value : DEFAULT_TRANSCRIPT_INTERVAL;
}
// Register before reading, so a delayed initial read cannot undo a live change.
export function watchTranscriptInterval(
  update: (seconds: number) => void,
  fail: (error: unknown) => void = () => {},
) {
  let disposed = false,
    revision = 0;
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    if (area !== "local" || !(TRANSCRIPT_INTERVAL_KEY in changes)) return;
    revision++;
    update(transcriptInterval(changes[TRANSCRIPT_INTERVAL_KEY].newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  void chrome.storage.local.get(TRANSCRIPT_INTERVAL_KEY).then(
    (values) => {
      if (!disposed && revision === 0)
        update(transcriptInterval(values[TRANSCRIPT_INTERVAL_KEY]));
    },
    (error) => {
      if (!disposed) fail(error);
    },
  );
  return () => {
    disposed = true;
    chrome.storage.onChanged.removeListener(listener);
  };
}
export type TranscriptItem = { cue: SubtitleCue; index: number };
export function transcriptParagraphs(items: TranscriptItem[], seconds: number) {
  const interval = transcriptInterval(seconds);
  const groups = new Map<number, TranscriptItem[]>();
  for (const item of items) {
    const bucket = Math.floor(item.cue.start / interval);
    const group = groups.get(bucket);
    if (group) group.push(item);
    else groups.set(bucket, [item]);
  }
  return [...groups].map(([bucket, items]) => ({ bucket, items }));
}
export function transcriptSeparator(previous: string, next: string) {
  // Keep Latin words separated without adding spaces between CJK fragments.
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(
    previous.trim(),
  ) &&
    /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}，。！？、；：]/u.test(
      next.trim(),
    )
    ? ""
    : " ";
}
