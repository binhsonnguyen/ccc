import { useEffect, useRef } from 'react';

// C-1: tiny activity sparkline drawn from a per-session 60-bucket
// bytes/sec ring. Downsampled 60 → 24 via max-pooling so each bar
// covers ~2.5 seconds. Renders nothing when there's no live PTY or
// no recent activity (peak === 0). DPR-scaled for retina.

interface Props {
  // null = no live PTY (or never fetched). Renders empty canvas so
  // layout stays stable across the live → dead transition.
  buckets: number[] | null;
  // Bar color — typically cwdTint(cwd) so the sparkline shares the
  // row's accent hue.
  color: string;
}

const W = 24;
const H = 6;
const BARS = 24;
const BUCKETS = 60;

// Max-pool 60 → 24. Each output bar is the max of the contiguous
// slice of input buckets that maps to it. Using max (not sum/avg)
// preserves bursty activity that an average would flatten.
function downsample(src: number[]): number[] {
  const out = new Array<number>(BARS).fill(0);
  for (let i = 0; i < BARS; i++) {
    const lo = Math.floor((i * BUCKETS) / BARS);
    const hi = Math.floor(((i + 1) * BUCKETS) / BARS);
    let m = 0;
    for (let j = lo; j < hi && j < src.length; j++) {
      if (src[j] > m) m = src[j];
    }
    out[i] = m;
  }
  return out;
}

export default function Sparkline({ buckets, color }: Props) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const cnv = ref.current;
    if (!cnv) return;
    const dpr = window.devicePixelRatio || 1;
    // Resize only when DPR or size changed — avoids unnecessary
    // clears on hot reload / re-render cycles.
    const pxW = Math.round(W * dpr);
    const pxH = Math.round(H * dpr);
    if (cnv.width !== pxW || cnv.height !== pxH) {
      cnv.width = pxW;
      cnv.height = pxH;
    }
    const ctx = cnv.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, pxW, pxH);

    if (!buckets || buckets.length === 0) return;

    const bars = downsample(buckets);
    let peak = 0;
    for (const v of bars) if (v > peak) peak = v;
    if (peak === 0) return;

    ctx.fillStyle = color;
    const barW = pxW / BARS;
    for (let i = 0; i < BARS; i++) {
      const v = bars[i];
      if (v === 0) continue;
      // At least 1 device pixel so non-zero traffic is always visible.
      const h = Math.max(1, Math.floor((pxH * v) / peak));
      const x = Math.floor(i * barW);
      const w = Math.max(1, Math.ceil(barW) - 1);
      const y = pxH - h;
      ctx.fillRect(x, y, w, h);
    }
  }, [buckets, color]);

  return (
    <canvas
      ref={ref}
      className="session-sparkline"
      width={W}
      height={H}
      aria-hidden="true"
    />
  );
}
