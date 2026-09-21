import { useState } from "react";

type Site = { url: string; favicon?: string };

function sources({ url, favicon }: Site) {
  const candidates: string[] = [];
  try {
    if (favicon?.trim()) {
      const icon = new URL(favicon, url);
      if (/^https?:$/.test(icon.protocol) || /^data:image\//i.test(icon.href))
        candidates.push(icon.href);
    }
  } catch { /* Invalid saved icons must not prevent the site-default lookup. */ }
  try {
    const page = new URL(url);
    if (/^https?:$/.test(page.protocol))
      candidates.push(new URL("/favicon.ico", page.origin).href);
  } catch { /* Malformed imported metadata uses the local fallback. */ }
  return [...new Set(candidates)];
}

/** Shared by cards and detail headers. No third-party favicon service. */
export function SiteIcon({ site, backdrop = false }: { site: Site; backdrop?: boolean }) {
  return <Artwork key={`${site.url}\n${site.favicon ?? ""}`} site={site} backdrop={backdrop} />;
}

function Artwork({ site, backdrop }: { site: Site; backdrop: boolean }) {
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const candidates = sources(site);
  let host = "";
  try { host = new URL(site.url).hostname.replace(/^www\./, ""); } catch { /* Use neutral fallback. */ }
  const hue = [...host].reduce((hash, letter) => (hash * 31 + letter.charCodeAt(0)) % 360, 0);
  return (
    <span className={backdrop ? "site-backdrop" : "site-icon"} aria-hidden="true">
      {!loaded && <span className="site-monogram" style={{ background: `hsl(${hue} 42% 36%)` }}>
        {host.charAt(0).toLocaleUpperCase() || "W"}
      </span>}
      {candidates[attempt] && (
        <img key={candidates[attempt]} src={candidates[attempt]} alt="" className={loaded ? undefined : "is-loading"}
          referrerPolicy="no-referrer" decoding="async" loading="lazy"
          onLoad={() => setLoaded(true)}
          onError={() => { setLoaded(false); setAttempt((value) => value + 1); }} />
      )}
    </span>
  );
}
