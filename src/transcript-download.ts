import { folderName } from "./model";
import { subtitleTime, type Transcript, type VideoTarget } from "./video-transcript";

export function transcriptMarkdown(transcript: Transcript, title: string, url: string) {
  if (!transcript.cues.length) throw Error("当前视频没有可下载的字幕。");
  const heading = title.replace(/[\r\n]+/g, " ").trim() || "视频字幕";
  return `# ${heading}\n\n- 视频：${url}\n- 来源：${transcript.source}\n\n## 字幕\n\n${transcript.cues.map(cue => `**${subtitleTime(cue.start)}** ${cue.text.trim().replace(/\s*\n\s*/g, " ")}`).join("\n\n")}\n`;
}

export function dualTranscriptMarkdown(native: Transcript, player: Transcript, title: string, url: string) {
  if (native.key !== player.key || !native.cues.length || !player.cues.length)
    throw Error("两个字幕来源未完整加载，无法下载。");
  const heading = title.replace(/[\r\n]+/g, " ").trim() || "视频字幕";
  const section = (name: string, transcript: Transcript) =>
    `## ${name}\n\n${transcript.cues.map(cue => `**${subtitleTime(cue.start)}** ${cue.text.trim().replace(/\s*\n\s*/g, " ")}`).join("\n\n")}`;
  return `# ${heading}\n\n- 视频：${url}\n\n${section("内容转文字", native)}\n\n${section("播放器字幕", player)}\n`;
}

export function downloadTranscript(transcript: Transcript, target: VideoTarget, title: string, url: string, player?: Transcript) {
  const markdown = player ? dualTranscriptMarkdown(transcript, player, title, url) : transcriptMarkdown(transcript, title, url);
  const id = target.key.replace(/[^a-zA-Z0-9_-]/g, "-");
  const name = `${folderName(title, id)}-字幕.md`;
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = name;
  document.body.append(link);
  try { link.click(); }
  finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  }
}
