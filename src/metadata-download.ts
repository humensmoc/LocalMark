import type { Page } from "./model";
import { metadataFileName } from "./metadata-names";

// Export the saved browser record, including changes still waiting for disk sync.
// This also works before connecting a directory or when its permission has expired.
export function downloadMetadata(page: Page) {
  const blob = new Blob([JSON.stringify(page, null, 2) + "\n"], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = metadataFileName(page.title, page.id);
  document.body.append(link);
  try { link.click(); }
  finally {
    link.remove();
    // Keep the URL alive while the browser takes ownership of the download.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
