// Presentation only. Anchor quotes deliberately keep their whitespace-normalized
// representation so that wrapping and translation toggles cannot move a mark.
export function readableQuote(ranges: Range[]): string {
  const sorted = [...ranges].sort((a, b) =>
    a.compareBoundaryPoints(Range.START_TO_START, b),
  );
  const styles = new WeakMap<Element, CSSStyleDeclaration>();
  const style = (el: Element) => {
    let value = styles.get(el);
    if (!value) {
      value = getComputedStyle(el);
      styles.set(el, value);
    }
    return value;
  };
  const visible = (el: Element) => {
    for (let p: Element | null = el; p; p = p.parentElement) {
      if (
        p.matches('[hidden],[aria-hidden="true"]') ||
        style(p).display === "none" ||
        style(p).visibility === "hidden"
      )
        return false;
    }
    return true;
  };
  const breaks = [...document.querySelectorAll("br")].filter(visible);
  const block = (el: Element, translation: Element | null) => {
    for (
      let p: Element | null = translation?.parentElement ?? el;
      p;
      p = p.parentElement
    ) {
      if (
        /^(block|list-item|table-cell|flex|grid|flow-root)$/.test(
          style(p).display,
        )
      )
        return p;
    }
    return null;
  };
  let output = "",
    previous: Range | undefined;
  let previousBlock: Element | null = null,
    previousTranslation: Element | null = null;
  for (const r of sorted) {
    const parent = r.startContainer.parentElement;
    if (!parent) continue;
    const pre = /^(pre|pre-wrap|break-spaces|pre-line)$/.test(
      style(parent).whiteSpace,
    );
    const text = pre
      ? r.toString().replace(/\r\n?/g, "\n")
      : r.toString().replace(/\s+/g, " ");
    if (!text.trim()) {
      if (output && !/\s$/.test(output)) output += pre ? text : " ";
      continue;
    }
    const translation = parent.closest(".immersive-translate-target-wrapper");
    const currentBlock = block(parent, translation);
    let separator = "";
    if (previous) {
      if (currentBlock !== previousBlock) separator = "\n\n";
      else if (translation !== previousTranslation) separator = "\n";
      else {
        const gap = document.createRange();
        gap.setStart(previous.endContainer, previous.endOffset);
        gap.setEnd(r.startContainer, r.startOffset);
        const count = breaks.filter((br) => gap.intersectsNode(br)).length;
        if (count) separator = "\n".repeat(Math.min(count, 2));
      }
    }
    if (separator) output = output.trimEnd() + separator;
    output +=
      !pre && (separator || /\s$/.test(output)) ? text.trimStart() : text;
    previous = r;
    previousBlock = currentBlock;
    previousTranslation = translation;
  }
  return output.trim();
}

export function existingQuoteLayout(saved: string, ranges: Range[]): string {
  // Do not replace edited excerpts or existing intentional line breaks.
  if (saved.includes("\n")) return saved;
  const formatted = readableQuote(ranges);
  return formatted.replace(/\s/g, "") === saved.replace(/\s/g, "")
    ? formatted
    : saved;
}
