import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { subtitleTime, type SubtitleCue } from "./video-transcript";
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
  onSeek,
}: {
  items: TranscriptItem[];
  seconds: number;
  current: number;
  onSeek: (cue: SubtitleCue) => void;
}) {
  const groups = useMemo(
    () => transcriptParagraphs(items, seconds),
    [items, seconds],
  );
  const [hover, setHover] = useState<Hover | null>(null);
  const popup = useRef<HTMLDivElement>(null),
    timeButton = useRef<HTMLButtonElement>(null);
  const hovered = useRef<Hover | null>(null),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const keep = () => clearTimeout(timer.current);
  function hide() {
    keep();
    hovered.current = null;
    setHover(null);
  }
  const leave = () => {
    keep();
    timer.current = setTimeout(hide, 140);
  };
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
      cancelAnimationFrame(frame);
      document.removeEventListener("scroll", moved, true);
      window.removeEventListener("resize", moved);
      document.removeEventListener("keydown", escape);
    };
  }, []);
  return (
    <>
      <div className="cues">
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
                    className={`cue${current === item.index ? " active" : ""}${hover?.item === item ? " hovered" : ""}`}
                    tabIndex={0}
                    data-start={item.cue.start}
                    onMouseEnter={(e) =>
                      show(item, e.currentTarget, e.clientX, e.clientY)
                    }
                    onMouseMove={(e) =>
                      show(item, e.currentTarget, e.clientX, e.clientY)
                    }
                    onMouseLeave={leave}
                    onFocus={(e) => show(item, e.currentTarget)}
                    onBlur={leave}
                    onClick={(e) =>
                      show(
                        item,
                        e.currentTarget,
                        e.detail ? e.clientX : undefined,
                        e.detail ? e.clientY : undefined,
                      )
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        timeButton.current?.focus();
                      }
                    }}
                  >
                    {item.cue.text}
                  </span>
                </Fragment>
              ))}
            </p>
          </div>
        ))}
      </div>
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
