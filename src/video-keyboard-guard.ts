// Runs at document_start, before video sites register their keyboard shortcuts.
// Shadow DOM retargets textarea events to the host outside the component.
const videoHost = "localmark-video-transcript";

function isEditable(node: EventTarget): node is HTMLElement {
  return node instanceof HTMLElement &&
    (node.isContentEditable || node.matches("input, textarea, select"));
}

function keepVideoTypingLocal(event: KeyboardEvent) {
  if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
  const root = document.getElementById(videoHost)?.shadowRoot;
  if (!root) return;
  const path = event.composedPath();
  if (path.some(node => isEditable(node) && node.getRootNode() === root)) {
    event.stopImmediatePropagation();
    return;
  }
  // After selecting subtitles, the first key starts the note while the
  // selection still owns focus. Move focus before the browser inserts it.
  if (event.type !== "keydown" || path.some(isEditable)) return;
  const editor = root.querySelector<HTMLDivElement>(".video-editor:popover-open");
  const input = editor?.querySelector("textarea");
  if (!input) return;
  input.focus({ preventScroll: true });
  event.stopImmediatePropagation();
}

for (const type of ["keydown", "keyup", "keypress"])
  window.addEventListener(type, keepVideoTypingLocal as EventListener, true);
