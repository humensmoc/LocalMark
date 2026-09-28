import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { subtitleTime, type SubtitleCue } from "./video-transcript";
import { colorInfo, type VideoMark } from "./model";
import { markCueRange } from "./video-marks";
import { Icon } from "./Icon";
import { ScreenshotImage } from "./ScreenshotImage";
import {
  transcriptParagraphs,
  transcriptSeparator,
  type TranscriptItem,
} from "./transcript-layout";

type Hover = {
  item: TranscriptItem;
  element: HTMLElement;
  line: DOMRect;
  pointerX?: number;
  pointerY?: number;
};
export function TranscriptParagraphs({
  items,
  seconds,
  current,
  marks,
  trackId,
  onSeek,
  onMarkerSeek,
  onSelection,
  onEdit,
}: {
  items: TranscriptItem[];
  seconds: number;
  current: number;
  marks: VideoMark[];
  trackId: string;
  onSeek: (cue: SubtitleCue) => void;
  onMarkerSeek: (seconds: number) => void;
  onSelection: (first: TranscriptItem, last: TranscriptItem, x: number, y: number) => void;
  onEdit: (mark: VideoMark, x: number, y: number) => void;
}) {
  const groups = useMemo(
    () => transcriptParagraphs(items, seconds),
    [items, seconds],
  );
  const [hover, setHover] = useState<Hover | null>(null);
  const [hoveredCommentId, setHoveredCommentId] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ mark: VideoMark; x: number; y: number } | null>(null);
  const cues = useMemo(() => {
    const sorted = items.slice().sort((a, b) => a.index - b.index);
    const result: SubtitleCue[] = [];
    for (const item of sorted) result[item.index] = item.cue;
    return result;
  }, [items]);
  const annotations = useMemo(() => {
    const covering = new Map<number, VideoMark[]>(), ending = new Map<number, VideoMark[]>(), points = new Map<number, VideoMark[]>();
    for (const mark of marks) {
      const range = markCueRange(mark, cues, trackId);
      if (!range) continue;
      if (mark.kind === "subtitle") {
        for (let index = range[0]; index <= range[1]; index++)
          covering.set(index, [...(covering.get(index) ?? []), mark]);
        ending.set(range[1], [...(ending.get(range[1]) ?? []), mark]);
      } else {
        covering.set(range[0], [...(covering.get(range[0]) ?? []), mark]);
        points.set(range[0], [...(points.get(range[0]) ?? []), mark]);
      }
    }
    return { covering, ending, points };
  }, [marks, cues, trackId]);
  const popup = useRef<HTMLDivElement>(null),
    timeButton = useRef<HTMLButtonElement>(null),
    cuesNode = useRef<HTMLDivElement>(null),
    selecting = useRef(false),
    finishSelection = useRef<((event: MouseEvent) => void) | null>(null);
  const hovered = useRef<Hover | null>(null),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const keep = () => clearTimeout(timer.current);
  const commentHoverProps = (mark: VideoMark) => ({
    onMouseEnter: () => setHoveredCommentId(mark.id),
    onMouseLeave: () => setHoveredCommentId(id => id === mark.id ? null : id),
    onFocusCapture: () => setHoveredCommentId(mark.id),
    onBlurCapture: (event: React.FocusEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null))
        setHoveredCommentId(id => id === mark.id ? null : id);
    },
  });
  function clickCommentCard(mark: VideoMark, event: React.MouseEvent<HTMLElement>) {
    if ((event.target as Element).closest("button") || window.getSelection()?.toString().trim()) return;
    onMarkerSeek(mark.time);
  }
  function hide() {
    keep();
    hovered.current = null;
    setHover(null);
  }
  const leave = () => {
    keep();
    timer.current = setTimeout(hide, 140);
  };
  function selected(event: MouseEvent) {
    const node = cuesNode.current;
    if (event.button !== 0 || !node) return;
    const root = node.getRootNode() as ShadowRoot & { getSelection?: () => Selection | null };
    const selection = root.getSelection?.() ?? window.getSelection();
    if (!selection || selection.isCollapsed || !selection.toString().trim() || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (range.commonAncestorContainer.getRootNode() !== root) return;
    const selectedItems = items.filter(item => {
      const element = node.querySelector<HTMLElement>(`.cue[data-index="${item.index}"]`);
      return element && range.intersectsNode(element.firstChild ?? element);
    }).sort((a, b) => a.index - b.index);
    if (!selectedItems.length) return;
    hide();
    onSelection(selectedItems[0], selectedItems[selectedItems.length - 1], event.clientX, event.clientY);
  }
  function startSelection(event: React.MouseEvent<HTMLDivElement>) {
    if (event.button !== 0 || !(event.target as Element).closest(".cue")) return;
    if (finishSelection.current) document.removeEventListener("mouseup", finishSelection.current);
    selecting.current = true;
    hide();
    const finish = (up: MouseEvent) => {
      selecting.current = false;
      finishSelection.current = null;
      selected(up);
    };
    finishSelection.current = finish;
    document.addEventListener("mouseup", finish, { once: true });
  }
  function showPreview(mark: VideoMark, event: React.MouseEvent<HTMLElement>) {
    if (mark.kind === "keyframe") setPreview({ mark, x: event.clientX, y: event.clientY });
  }
  function position() {
    if (!popup.current || !hovered.current) return;
    const bounds = popup.current.getBoundingClientRect(),
      { line, pointerX } = hovered.current;
    const left =
      pointerX === undefined ? line.left : pointerX - bounds.width / 2;
    popup.current.style.left = `${Math.max(8, Math.min(left, innerWidth - bounds.width - 8))}px`;
    popup.current.style.top = `${Math.max(8, line.top - bounds.height)}px`;
  }
  function show(
    item: TranscriptItem,
    element: HTMLElement,
    x?: number,
    y?: number,
  ) {
    if (selecting.current) return;
    keep();
    const container = element.closest(".body")?.getBoundingClientRect();
    const rects = [...element.getClientRects()].filter(
      (r) =>
        r.bottom > Math.max(0, container?.top ?? 0) &&
        r.top < Math.min(innerHeight, container?.bottom ?? innerHeight),
    );
    // Anchor to the line under the pointer, not the start of a wrapped sentence.
    // Nearest-line selection also handles the small space between line boxes.
    const line =
      y === undefined
        ? rects[0]
        : rects.reduce<DOMRect | undefined>(
            (nearest, r) =>
              !nearest ||
              Math.abs((r.top + r.bottom) / 2 - y) <
                Math.abs((nearest.top + nearest.bottom) / 2 - y)
                ? r
                : nearest,
            undefined,
          );
    const next = {
      item,
      element,
      line: line || element.getBoundingClientRect(),
      pointerX: x,
      pointerY: y,
    };
    if (hovered.current?.item === item) {
      hovered.current = next;
      position();
      return;
    }
    hovered.current = next;
    setHover(next);
  }
  useEffect(() => {
    if (!hover || !popup.current) return;
    const node = popup.current;
    node.showPopover();
    position();
    return () => {
      if (node.isConnected && node.matches(":popover-open")) node.hidePopover();
    };
  }, [hover]);
  useEffect(() => {
    hide();
  }, [items, seconds]);
  useEffect(() => {
    let frame = 0;
    const moved = () => {
      cancelAnimationFrame(frame);
      const active = hovered.current;
      const focused = active?.element.getRootNode() as ShadowRoot | undefined;
      if (
        active &&
        (focused?.activeElement === active.element ||
          popup.current?.contains(focused?.activeElement ?? null) ||
          active.element.matches(":hover"))
      ) {
        // Focusing a wrapped sentence can scroll its container after onFocus.
        // Keep keyboard access and re-anchor to the sentence's visible line.
        frame = requestAnimationFrame(() => {
          if (hovered.current === active)
            show(active.item, active.element, active.pointerX, active.pointerY);
        });
      } else hide();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    document.addEventListener("scroll", moved, true);
    window.addEventListener("resize", moved);
    document.addEventListener("keydown", escape);
    return () => {
      keep();
      if (finishSelection.current) document.removeEventListener("mouseup", finishSelection.current);
      cancelAnimationFrame(frame);
      document.removeEventListener("scroll", moved, true);
      window.removeEventListener("resize", moved);
      document.removeEventListener("keydown", escape);
    };
  }, []);
  return (
    <>
      <div ref={cuesNode} className="cues" onMouseDownCapture={startSelection}>
        {groups.map((group) => (
          <div className="subtitle-paragraph" key={group.bucket}>
            <button
              className="paragraph-time"
              onClick={() => onSeek(group.items[0].cue)}
              title={`跳转到 ${subtitleTime(group.items[0].cue.start)} 并暂停`}
            >
              {subtitleTime(group.items[0].cue.start)}
            </button>
            <p className="paragraph-text">
              {group.items.map((item, i) => (
                <Fragment key={item.index}>
                  {i > 0 &&
                    transcriptSeparator(
                      group.items[i - 1].cue.text,
                      item.cue.text,
                    )}
                  <span
                    className={`cue${current === item.index ? " active" : ""}${hover?.item === item || annotations.covering.get(item.index)?.some(mark => mark.kind === "subtitle" && mark.id === hoveredCommentId) ? " hovered" : ""}${annotations.covering.has(item.index) ? " annotated" : ""}`}
                    style={annotations.covering.has(item.index) ? { "--annotation": colorInfo(annotations.covering.get(item.index)!.at(-1)!.color).hex } as React.CSSProperties : undefined}
                    tabIndex={0}
                    data-start={item.cue.start}
                    data-index={item.index}
                    onMouseEnter={(e) =>
                      show(item, e.currentTarget, e.clientX, e.clientY)
                    }
                    onMouseMove={(e) =>
                      show(item, e.currentTarget, e.clientX, e.clientY)
                    }
                    onMouseLeave={leave}
                    onFocus={(e) => show(item, e.currentTarget)}
                    onBlur={leave}
                    onClick={(e) => {
                      if (window.getSelection()?.toString().trim()) return;
                      const marked = annotations.covering.get(item.index)?.at(-1);
                      if (marked && e.detail) onEdit(marked, e.clientX, e.clientY);
                      else show(
                        item,
                        e.currentTarget,
                        e.detail ? e.clientX : undefined,
                        e.detail ? e.clientY : undefined,
                      );
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        timeButton.current?.focus();
                      }
                    }}
                  >
                    {item.cue.text}
                  </span>
                  {((annotations.ending.get(item.index)?.length ?? 0) > 0 || (annotations.points.get(item.index)?.length ?? 0) > 0) && (
                    <span className="cue-inserts">
                      {annotations.ending.get(item.index)?.filter(mark => mark.note.trim()).map(mark => (
                        <span key={mark.id} className="cue-note" data-mark-id={mark.id} style={{ "--annotation": colorInfo(mark.color).hex } as React.CSSProperties} {...commentHoverProps(mark)} onClick={event => clickCommentCard(mark, event)}>
                          <button type="button" className="cue-note-jump" title={`跳转到 ${subtitleTime(mark.time)} 并暂停`} onClick={() => onMarkerSeek(mark.time)}>{mark.note}</button>
                          <button type="button" className="cue-note-edit" onClick={e => onEdit(mark, e.clientX, e.clientY)} aria-label="编辑字幕批注"><Icon name="pen" size={13} /></button>
                        </span>
                      ))}
                      {!!annotations.points.get(item.index)?.length && (
                        <span className="cue-timeline" aria-label="字幕时间点">
                          {annotations.points.get(item.index)!.slice().sort((a, b) => a.time - b.time).map(mark => {
                            return <span key={mark.id} className={`cue-marker${hoveredCommentId === mark.id ? " comment-hovered" : ""}`} data-mark-id={mark.id}>
                              <button type="button" aria-label={`${mark.kind === "screenshot" ? "截图" : mark.kind === "comment" ? "视频评论" : "关键帧"} ${subtitleTime(mark.time)}，跳转视频`} onMouseEnter={e => showPreview(mark, e)} onMouseLeave={() => setPreview(null)} onClick={() => onMarkerSeek(mark.time)}>
                                {mark.kind === "screenshot" ? <ScreenshotImage mark={mark} size="timeline" /> : <Icon name={mark.kind === "comment" ? "comment" : "bookmark"} size={15} />}
                              </button>
                              <button type="button" className="marker-edit" aria-label="编辑时间点标注" onClick={e => onEdit(mark, e.clientX, e.clientY)}><Icon name="pen" size={12} /></button>
                            </span>;
                          })}
                        </span>
                      )}
                      {annotations.points.get(item.index)?.filter(mark => mark.note.trim()).map(mark => (
                        <span key={mark.id} className="cue-note point-note" data-mark-id={mark.id} style={{ "--annotation": colorInfo(mark.color).hex } as React.CSSProperties} {...commentHoverProps(mark)}
                          onClick={event => clickCommentCard(mark, event)}>
                          <span className="cue-note-heading" aria-label={mark.kind === "screenshot" ? "截图" : mark.kind === "comment" ? "视频评论" : "关键帧"}>
                            {mark.kind === "screenshot" ? <ScreenshotImage mark={mark} size="comment" /> : <Icon name={mark.kind === "comment" ? "comment" : "bookmark"} size={15} />}
                            <strong>{subtitleTime(mark.time)}</strong>
                          </span> <button type="button" className="cue-note-jump" title={`跳转到 ${subtitleTime(mark.time)} 并暂停`} onClick={() => onMarkerSeek(mark.time)}>{mark.note}</button>
                        </span>
                      ))}
                    </span>
                  )}
                </Fragment>
              ))}
            </p>
          </div>
        ))}
      </div>
      {preview && <div className="marker-preview" style={{ left: Math.max(8, Math.min(innerWidth - 220, preview.x + 10)), top: Math.max(8, Math.min(innerHeight - 70, preview.y + 12)) }} role="tooltip">
        <strong>关键帧 {subtitleTime(preview.mark.time)}</strong>
        {preview.mark.note && <p>{preview.mark.note}</p>}
      </div>}
      {hover && (
        <div
          ref={popup}
          popover="manual"
          className="cue-time-popup"
          onMouseEnter={keep}
          onMouseLeave={leave}
          onFocus={keep}
          onBlur={leave}
        >
          <button
            ref={timeButton}
            className="cue-time-button"
            onClick={() => onSeek(hover.item.cue)}
            aria-label={`跳转到 ${subtitleTime(hover.item.cue.start)} 并暂停`}
          >
            {subtitleTime(hover.item.cue.start)}
          </button>
        </div>
      )}
    </>
  );
}
