import { useEffect, useState } from "react";
import {
  DEFAULT_TRANSCRIPT_INTERVAL,
  TRANSCRIPT_INTERVAL_KEY,
  validTranscriptInterval,
  watchTranscriptInterval,
} from "./transcript-layout";

export function TranscriptSettings() {
  const [value, setValue] = useState(String(DEFAULT_TRANSCRIPT_INTERVAL));
  const [ready, setReady] = useState(false),
    [saving, setSaving] = useState(false);
  const [error, setError] = useState(""),
    [status, setStatus] = useState("");
  useEffect(
    () =>
      watchTranscriptInterval(
        (seconds) => {
          setValue(String(seconds));
          setReady(true);
        },
        () => {
          setError("字幕设置读取失败，请刷新设置页重试。");
        },
      ),
    [],
  );
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setStatus("");
    const seconds = value.trim() ? Number(value) : NaN;
    if (!validTranscriptInterval(seconds)) {
      setError("请输入 1～600 之间的整数秒数。");
      return;
    }
    setSaving(true);
    try {
      await chrome.storage.local.set({ [TRANSCRIPT_INTERVAL_KEY]: seconds });
      setStatus("已保存，已打开的视频页面会立即重新分段。");
    } catch {
      setError("字幕设置保存失败，请重试。");
    } finally {
      setSaving(false);
    }
  }
  return (
    <section>
      <h2>视频字幕</h2>
      <p>
        Bilibili、YouTube 和 GDC Vault 的字幕按时长合并成段落，默认每 30
        秒一段。
      </p>
      <form onSubmit={(event) => void save(event)} noValidate>
        <div className="transcript-setting">
          <label htmlFor="transcript-interval">每段时长（秒）</label>
          <input
            id="transcript-interval"
            type="number"
            min={1}
            max={600}
            step={1}
            value={value}
            disabled={!ready || saving}
            aria-describedby="transcript-interval-help"
            onChange={(event) => {
              setValue(event.target.value);
              setError("");
              setStatus("");
            }}
          />
          <button type="submit" disabled={!ready || saving}>
            保存字幕设置
          </button>
        </div>
        <p id="transcript-interval-help">
          可设置 1～600 秒，跨越分段边界的字幕会保持完整。
        </p>
        {error && <p role="alert">{error}</p>}
        {status && <p role="status">{status}</p>}
      </form>
    </section>
  );
}
