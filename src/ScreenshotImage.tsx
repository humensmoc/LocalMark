import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { VideoMark } from "./model";

const images = new Map<string, Promise<string>>();

function imageFor(mark: VideoMark): Promise<string> {
  const cached = images.get(mark.id);
  if (cached) return cached;
  const pending = chrome.runtime.sendMessage({ type: "video-image", id: mark.id }).then(reply => {
    if (!reply?.ok || typeof reply.data !== "string") throw Error(reply?.error || "无法读取截图");
    return reply.data as string;
  }).catch(error => {
    images.delete(mark.id);
    throw error;
  });
  images.set(mark.id, pending);
  return pending;
}

export function ScreenshotImage({ mark, size = "card", allowPreview = true }: { mark: VideoMark; size?: "card" | "small" | "timeline" | "comment"; allowPreview?: boolean }) {
  const [source, setSource] = useState("");
  const [error, setError] = useState("");
  const [hover, setHover] = useState(false);
  const anchor = useRef<HTMLImageElement>(null);
  const preview = useRef<HTMLImageElement>(null);
  useEffect(() => {
    let active = true;
    setSource(""); setError("");
    void imageFor(mark).then(value => { if (active) setSource(value); }, cause => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [mark.id, mark.updatedAt]);
  const position = () => {
    if (!preview.current || !anchor.current) return;
    const image = preview.current, box = anchor.current.getBoundingClientRect();
    const width = image.getBoundingClientRect().width, height = image.getBoundingClientRect().height;
    const maxX = Math.max(8, innerWidth - width - 8), maxY = Math.max(8, innerHeight - height - 8);
    const x = box.right + width + 12 <= innerWidth - 8 ? box.right + 12
      : box.left - width - 12 >= 8 ? box.left - width - 12 : box.left;
    image.style.left = `${Math.max(8, Math.min(x, maxX))}px`;
    image.style.top = `${Math.max(8, Math.min(box.top, maxY))}px`;
  };
  useLayoutEffect(() => {
    if (!hover || !source) return;
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => { window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); };
  }, [hover, source]);
  const dimensions: CSSProperties = size === "comment" ? { width: 34, height: 21, objectFit: "cover" }
    : size === "timeline" ? { width: 46, height: 27, objectFit: "cover" }
    : size === "small" ? { width: 72, height: 48, objectFit: "cover" }
      : { width: "100%", maxHeight: 190, objectFit: "contain" };
  return <>
    {source ? <img ref={anchor} src={source} alt="视频截图" className="screenshot-image" style={{ display: "block", maxWidth: "100%", borderRadius: 4, ...dimensions }}
      onMouseEnter={allowPreview ? () => setHover(true) : undefined} onMouseLeave={allowPreview ? () => setHover(false) : undefined}
      onFocus={allowPreview ? () => setHover(true) : undefined} onBlur={allowPreview ? () => setHover(false) : undefined} tabIndex={allowPreview ? 0 : undefined} />
      : <span className="screenshot-image-placeholder" role="status" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", minWidth: size === "comment" ? 34 : size === "timeline" ? 46 : 72, minHeight: size === "comment" ? 21 : size === "timeline" ? 27 : 48, fontSize: 10, color: "#9aa7b5" }}>
        {error ? "图片不可用" : "读取中"}
      </span>}
    {allowPreview && hover && source && createPortal(<img ref={preview} src={source} alt="视频截图预览" onLoad={position}
      style={{ position: "fixed", left: 8, top: 8, zIndex: 2147483646, display: "block", width: `min(480px, calc(100vw - 16px))`, maxHeight: `min(340px, calc(100vh - 16px))`, objectFit: "contain", pointerEvents: "none", border: 0, borderRadius: 0, padding: 0, background: "transparent", boxShadow: "none" }} />, document.body)}
  </>;
}

export function ScreenshotGallery({ marks, allowPreview = true }: { marks: VideoMark[]; allowPreview?: boolean }) {
  if (!marks.length) return null;
  return <div className="screenshot-gallery" aria-label={`${marks.length} 张视频截图`}
    style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 9, minWidth: 0 }}>
    {marks.map(mark => <ScreenshotImage key={mark.id} mark={mark} size={marks.length > 1 ? "small" : "card"} allowPreview={allowPreview} />)}
  </div>;
}
