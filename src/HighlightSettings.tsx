import { useEffect, useState } from "react";
import { COLORS, colorInfo, highlightPalette, HighlightPaletteSchema, DEFAULT_HIGHLIGHT_PALETTE, type Color, type Library } from "./model";
import { request } from "./protocol";

export function HighlightSettings({ lib, saved }: { lib: Library; saved: (lib: Library) => void }) {
  const [colors, setColors] = useState(() => highlightPalette(lib));
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [status, setStatus] = useState("");
  const paletteKey = JSON.stringify(highlightPalette(lib));
  useEffect(() => { setColors(JSON.parse(paletteKey)); }, [paletteKey]);
  function change(next: Color[]) { setColors(next); setError(""); setStatus(""); }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    const result = HighlightPaletteSchema.safeParse(colors);
    if (!result.success) { setError("请选择 1～8 种不同的颜色。"); return; }
    setBusy(true); setError(""); setStatus("");
    try {
      saved(await request({ type: "highlight-palette", colors: result.data }));
      setStatus("已保存，已打开网页的标注浮窗会立即更新。");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <section className="highlight-settings">
    <h2>划词标注浮窗</h2>
    <p>默认三色。点击色块可自选颜色，添加或移除可调整数量（1～8 色）。修改色板不改变已有高亮的颜色。</p>
    <form onSubmit={event => void save(event)}>
      <fieldset disabled={busy}>
        <div className="palette-list">
          {colors.map((color, index) => <div className="palette-setting" key={index}>
            <label htmlFor={`highlight-color-${index}`}>颜色 {index + 1}</label>
            <input id={`highlight-color-${index}`} type="color" value={colorInfo(color).hex}
              onChange={event => {
                const hex = event.target.value.toLowerCase();
                const preset = Object.entries(COLORS).find(([, info]) => info.hex === hex)?.[0];
                change(colors.map((c, i) => i === index ? (preset ?? hex) as Color : c));
              }} />
            <code>{colorInfo(color).hex.toUpperCase()}</code>
            <button type="button" disabled={colors.length === 1} aria-label={`移除颜色 ${index + 1}`}
              onClick={() => change(colors.filter((_, i) => i !== index))}>移除</button>
          </div>)}
        </div>
        <div className="actions palette-actions">
          <button type="button" disabled={colors.length >= 8} onClick={() => {
            const candidates: Color[] = ["blue", "purple", "pink", "yellow", "green", "#ffb380", "#b5d6aa", "#c4c4c4"];
            const next = candidates.find(c => !colors.some(color => colorInfo(color).hex === colorInfo(c).hex))!;
            change([...colors, next]);
          }}>添加颜色</button>
          <button type="button" onClick={() => change([...DEFAULT_HIGHLIGHT_PALETTE])}>恢复默认三色</button>
          <button type="submit" className="primary">{busy ? "保存中…" : "保存浮窗设置"}</button>
        </div>
      </fieldset>
      {error && <p role="alert" className="error">{error}</p>}
      {status && <p role="status">{status}</p>}
    </form>
  </section>;
}
