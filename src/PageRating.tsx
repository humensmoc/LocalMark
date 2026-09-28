import { useRef, useState, type CSSProperties } from "react";
import "./rating.css";

const colors = ["#8693a5", "#f08080", "#eea05b", "#e4c45c", "#60c6a3", "#b99af2"];
const steps = [1, 2, 3, 4, 5];
const starPath = "m12 2.5 2.94 5.96 6.58.96-4.76 4.64 1.12 6.55L12 17.52l-5.88 3.09 1.12-6.55-4.76-4.64 6.58-.96Z";
const style = (rating: number): CSSProperties => ({ "--rating-color": colors[rating] } as CSSProperties);

export function RatingFilterStars({ rating }: { rating: number }) {
  return <span className={`rating-filter-stars${rating ? "" : " unrated"}`} style={style(rating)} aria-hidden="true">
    {Array.from({ length: rating || 5 }, (_, index) => <svg key={index} viewBox="0 0 24 24"><path d={starPath} /></svg>)}
  </span>;
}

export function RatingDots({ rating = 0 }: { rating?: number }) {
  const label = rating ? `评分：${rating} / 5 星` : "未评分";
  return <span className="rating-dots" style={style(rating)} role="img" aria-label={label} title={label}>
    {steps.map(n => <i key={n} className={n <= rating ? "filled" : undefined} aria-hidden="true" />)}
  </span>;
}

export function PageRating({ rating = 0, change, refresh }: {
  rating?: number;
  change: (rating: number | null) => Promise<void>;
  refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [preview, setPreview] = useState<number | null>(null);
  const [error, setError] = useState("");
  async function save(value: number | null) {
    if (pending.current || (value ?? 0) === rating) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try { await change(value); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { pending.current = false; setBusy(false); setPreview(null); }
  }
  const shown = preview ?? rating;
  return <section className="page-rating" aria-label="网页评分">
    <div className="rating-editor-row">
      <span className="rating-label">评分</span>
      <div className="rating-stars" role="group" aria-label="选择星级" style={style(shown)} onMouseLeave={() => setPreview(null)}>
        {steps.map(n => <button key={n} type="button" aria-label={`${n} 星`} aria-pressed={rating === n}
          title={`评为 ${n} 星`} disabled={busy} onMouseEnter={() => setPreview(n)} onFocus={() => setPreview(n)} onBlur={() => setPreview(null)} onClick={() => void save(n)}>
          <svg viewBox="0 0 24 24" aria-hidden="true" className={n <= shown ? "filled" : undefined}>
            <path d={starPath} />
          </svg>
        </button>)}
      </div>
      <small className="rating-value" aria-live="polite">{busy ? "保存中…" : rating ? `${rating} / 5` : "未评分"}</small>
      <button type="button" className="rating-clear" disabled={busy || !rating} onClick={() => void save(null)}>清除</button>
    </div>
    {error && <div className="error" role="alert">{error}<button type="button" disabled={busy} onClick={() => {
      void refresh().then(() => setError("")).catch(e => setError(String(e)));
    }}>读取最新评分</button></div>}
  </section>;
}
