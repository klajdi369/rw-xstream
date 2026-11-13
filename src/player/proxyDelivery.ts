const DELIVERY_WINDOW_MS = 8000;
const STALL_RATE = 0.92;

export function monitorProxyDelivery() {
  const samples: { time: number; end: number }[] = [];
  let rate: number | null = null;
  let slowStalls = 0;

  return {
    sample(time: number, end: number) {
      // A discontinuous range or a newly attached source needs a fresh window.
      const last = samples[samples.length - 1];
      if (last && (end < last.end || end - last.end > 5)) {
        samples.length = 0;
        rate = null;
      }
      samples.push({ time, end });
      while (samples.length > 1 && time - samples[1].time >= DELIVERY_WINDOW_MS) samples.shift();
      const duration = time - samples[0].time;
      if (duration >= DELIVERY_WINDOW_MS) rate = (end - samples[0].end) * 1000 / duration;
    },
    stall() {
      slowStalls = rate !== null && rate < STALL_RATE ? slowStalls + 1 : 0;
      return { rate, slowStalls };
    },
  };
}
