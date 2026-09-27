import {
  cloneElement,
  useLayoutEffect,
  useRef,
  useState,
  type PropsWithChildren,
  type ReactElement,
  type MouseEventHandler,
  type RefObject,
} from "react";

const MOTION_DURATION = 180;

type FloatingProps = PropsWithChildren<{
  x: number;
  y: number;
  className: string;
  onMouseDown?: MouseEventHandler<HTMLDivElement>;
  onMouseEnter?: MouseEventHandler<HTMLDivElement>;
  onMouseLeave?: MouseEventHandler<HTMLDivElement>;
  elementRef?: RefObject<HTMLDivElement | null>;
  anchorRef?: RefObject<HTMLElement | null>;
  pointerPosition?: RefObject<{ x: number; y: number }>;
  focusRef?: RefObject<HTMLTextAreaElement | null>;
  draggable?: boolean;
  positionKey?: unknown;
  open?: boolean;
  onExited?: () => void;
}>;

// Keep the last rendered popup until its exit animation finishes. Reopening
// reuses the same element, so an unfinished exit can reverse without flicker.
export function FloatingPresence({
  children,
}: {
  children: ReactElement<FloatingProps> | null | false | undefined;
}) {
  const [retained, setRetained] = useState(children);
  if (children && children !== retained) setRetained(children);
  const content = children || retained;
  return content
    ? cloneElement(content, {
        open: !!children,
        onExited: () => setRetained(null),
      })
    : null;
}

// Measure rendered content instead of estimating editor height from its fields.
export function Floating({
  x,
  y,
  className,
  children,
  onMouseDown,
  onMouseEnter,
  onMouseLeave,
  elementRef,
  anchorRef,
  pointerPosition,
  focusRef,
  draggable = false,
  positionKey,
  open = true,
  onExited,
}: FloatingProps) {
  const localRef = useRef<HTMLDivElement>(null);
  const ref = elementRef ?? localRef;
  const motion = useRef<Animation | null>(null);
  const exitRef = useRef(onExited);
  const draggedPosition = useRef<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    exitRef.current = onExited;
  });
  useLayoutEffect(() => {
    // A new selection starts beside the pointer; preserve a dragged position
    // through input updates and while the current editor animates out.
    if (open) draggedPosition.current = null;
  }, [open, x, y, positionKey]);
  useLayoutEffect(() => {
    const el = ref.current!;
    const position = () => {
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0,
        top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? innerWidth,
        height = viewport?.height ?? innerHeight;
      const margin = 12;
      el.style.maxWidth = `${Math.max(0, width - margin * 2)}px`;
      el.style.maxHeight = `${Math.max(0, height - margin * 2)}px`;
      const bounds = el.getBoundingClientRect();
      const anchor =
        !draggedPosition.current && anchorRef?.current?.getBoundingClientRect();
      let targetX = draggedPosition.current?.x ?? x,
        targetY = draggedPosition.current?.y ?? y;
      if (pointerPosition) {
        const point = pointerPosition.current;
        targetX = point.x + 14;
        targetY = point.y + 8;
        if (targetX + bounds.width > left + width - margin)
          targetX = point.x - bounds.width - 14;
      }
      if (anchor) {
        // Reserve the quick button's entire rectangle, even in a short viewport.
        const gap = 8;
        const below = Math.max(0, top + height - margin - anchor.bottom - gap);
        const above = Math.max(0, anchor.top - gap - top - margin);
        const placeBelow = below >= bounds.height || below >= above;
        const available = placeBelow ? below : above;
        el.style.maxHeight = `${available}px`;
        const panelHeight = el.getBoundingClientRect().height;
        targetX = anchor.left;
        targetY = placeBelow
          ? anchor.bottom + gap
          : anchor.top - gap - panelHeight;
      }
      el.style.left = `${Math.max(left + margin, Math.min(targetX, left + width - bounds.width - margin))}px`;
      el.style.top = `${Math.max(top + margin, Math.min(targetY, top + height - el.getBoundingClientRect().height - margin))}px`;
      if (draggedPosition.current) {
        draggedPosition.current = {
          x: parseFloat(el.style.left),
          y: parseFloat(el.style.top),
        };
      }
    };
    position();
    let pointerFrame = 0;
    const followPointer = () => {
      if (!pointerFrame) pointerFrame = requestAnimationFrame(() => {
        pointerFrame = 0;
        position();
      });
    };
    if (pointerPosition) document.addEventListener("mousemove", followPointer);
    let drag: {
      id: number;
      startX: number;
      startY: number;
      x: number;
      y: number;
      moved: boolean;
    } | null = null;
    const stopDrag = () => {
      const id = drag?.id;
      drag = null;
      delete el.dataset.dragging;
      if (id !== undefined && el.hasPointerCapture(id))
        el.releasePointerCapture(id);
    };
    const down = (event: PointerEvent) => {
      if (!draggable || !open || drag || event.button !== 0 || !event.isPrimary)
        return;
      const target = event.target;
      if (
        !(target instanceof Element) ||
        !target.closest("[data-floating-drag-handle]") ||
        target.closest("button,input,textarea,a,select")
      )
        return;
      event.preventDefault();
      // Keep the drag offset independent of the entrance animation's movement.
      motion.current?.finish();
      drag = {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        x: parseFloat(el.style.left),
        y: parseFloat(el.style.top),
        moved: false,
      };
      el.setPointerCapture(event.pointerId);
      el.dataset.dragging = "true";
    };
    const move = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.startX,
        dy = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < 3) return;
      drag.moved = true;
      event.preventDefault();
      draggedPosition.current = { x: drag.x + dx, y: drag.y + dy };
      position();
    };
    const up = (event: PointerEvent) => {
      if (event.pointerId === drag?.id) stopDrag();
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("lostpointercapture", up);
    window.addEventListener("blur", stopDrag);
    const observer = new ResizeObserver(position);
    observer.observe(el);
    if (anchorRef?.current) observer.observe(anchorRef.current);
    window.addEventListener("resize", position);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    return () => {
      cancelAnimationFrame(pointerFrame);
      document.removeEventListener("mousemove", followPointer);
      stopDrag();
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.removeEventListener("lostpointercapture", up);
      window.removeEventListener("blur", stopDrag);
      observer.disconnect();
      window.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
    };
  }, [x, y, className, ref, anchorRef, pointerPosition, draggable, positionKey, open]);
  useLayoutEffect(() => {
    const el = ref.current!;
    // The quick button is also the editor's positioning anchor: fade it only.
    const animation = el.animate(
      [
        { opacity: 0, translate: className === "quick" || className === "tooltip" ? "0 0" : "0 4px" },
        { opacity: 1, translate: "0 0" },
      ],
      {
        duration: className === "tooltip" ? 60 : MOTION_DURATION,
        easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
        fill: "both",
      },
    );
    animation.pause();
    motion.current = animation;
    return () => {
      animation.cancel();
      motion.current = null;
    };
  }, [className, ref]);
  useLayoutEffect(() => {
    const animation = motion.current!;
    const duration = className === "tooltip" ? 60 : MOTION_DURATION;
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    const play = () => {
      animation.onfinish = open ? null : () => exitRef.current?.();
      animation.playbackRate = open ? 1 : -1;
      const atTarget = open
        ? Number(animation.currentTime) >= duration
        : Number(animation.currentTime) <= 0;
      // play() rewinds a finished animation. Keep its endpoint when a popup
      // closes before the first frame or motion preferences change while open.
      if (preference.matches || atTarget) {
        animation.pause();
        animation.currentTime = open ? duration : 0;
        if (!open) exitRef.current?.();
      } else {
        animation.play();
      }
    };
    play();
    preference.addEventListener("change", play);
    return () => {
      animation.onfinish = null;
      preference.removeEventListener("change", play);
    };
  }, [open, className, ref]);
  useLayoutEffect(() => {
    if (open) focusRef?.current?.focus({ preventScroll: true });
  }, [open, focusRef, positionKey]);
  return (
    <div
      ref={ref}
      className={`floating ${className}`}
      data-state={open ? "open" : "closing"}
      inert={!open}
      aria-hidden={!open}
      style={{ pointerEvents: open ? undefined : "none" }}
      onMouseDown={onMouseDown}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {children}
    </div>
  );
}
