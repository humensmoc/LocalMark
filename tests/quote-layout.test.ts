// @vitest-environment jsdom
import { expect, it } from "vitest";
import { capture, captureSelection, resolveAnchor } from "../src/anchors";
import { existingQuoteLayout } from "../src/quote-layout";

function select(html: string) {
  document.body.innerHTML = html;
  const range = document.createRange();
  range.selectNodeContents(document.body);
  return range;
}
const translated = (source: string, target: string) =>
  `<p data-imt-p="1">${source}<font class="immersive-translate-target-wrapper"><font class="immersive-translate-target-inner">${target}</font></font></p>`;

it("separates source and translation even when the translator inserts no br or space", () => {
  const r = select(
    translated("Which will you choose?", "你会选择哪一个？") +
      translated("The action that helps me win.", "帮助我取得胜利的行动。"),
  );
  const result = captureSelection(r)!;
  expect(result.text).toBe(
    "Which will you choose?\n你会选择哪一个？\n\nThe action that helps me win.\n帮助我取得胜利的行动。",
  );
  expect(result.anchor.exact).toBe(
    "Which will you choose? The action that helps me win.",
  );
});
it("preserves ordinary paragraphs, explicit breaks and list item boundaries", () => {
  const r = select(
    "<p>Hello <b>world</b>.<br>Another line.</p><p>Next paragraph.</p><ul><li>First item</li><li>Second item</li></ul>",
  );
  const result = captureSelection(r)!;
  expect(result.text).toBe(
    "Hello world.\nAnother line.\n\nNext paragraph.\n\nFirst item\n\nSecond item",
  );
  expect(result.anchor.exact).toBe(capture(r)!.exact);
  expect(resolveAnchor(result.anchor)).not.toBeNull();
});
it("retains preformatted line breaks and indentation within the quote", () => {
  const r = select(
    '<pre style="white-space:pre">first\n  indented\nlast</pre>',
  );
  expect(captureSelection(r)!.text).toBe("first\n  indented\nlast");
});
it("does not break inline emphasis, links, mixed languages or HTML source whitespace", () => {
  const r = select(
    '<p>Read\n <b>this</b> <a href="#">link</a> and use AI工具.</p>',
  );
  expect(captureSelection(r)!.text).toBe("Read this link and use AI工具.");
});
it("omits hidden breaks and keeps double br as an empty line", () => {
  const r = select(
    '<p>before<span style="display:none">hidden<br></span>after<br><br>last</p>',
  );
  expect(captureSelection(r)!.text).toBe("beforeafter\n\nlast");
});
it("formats only the selected substring without adding neighboring words", () => {
  select("<p>before first<br>second after</p>");
  const r = document.createRange(),
    p = document.querySelector("p")!;
  r.setStart(p.firstChild!, 7);
  r.setEnd(p.lastChild!, 6);
  expect(captureSelection(r)!.text).toBe("first\nsecond");
});
it("can format an old collapsed quote while preserving manually edited content", () => {
  const r = select(
    translated("Source.", "中文。") + translated("Next.", "下一段。"),
  );
  const old = capture(r)!;
  const resolved = resolveAnchor(old)!;
  expect(existingQuoteLayout(old.exact, resolved.exact)).toBe(
    "Source.\n中文。\n\nNext.\n下一段。",
  );
  expect(existingQuoteLayout("Manually rewritten.", resolved.exact)).toBe(
    "Manually rewritten.",
  );
  expect(existingQuoteLayout("Custom\nlayout", resolved.exact)).toBe(
    "Custom\nlayout",
  );
});
