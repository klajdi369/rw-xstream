import toneUrl from './fixtures/browser-test-tone.mp3?inline';
import clipUrl from './fixtures/browser-test-clip.webm?inline';

const WIDTH = 720;
const HEIGHT = 576;
const FPS = 25;
const SAMPLE_RATE = 48000;
const AVC = 'avc1.42001e';
const AAC = 'mp4a.40.2';

function result(label: string, work: () => Promise<string>): Promise<string> {
  return Promise.resolve().then(work).then((detail) => `${label} · ${detail}`, (error: unknown) => {
    const name = error instanceof Error ? error.name : '';
    const detail = /^[A-Za-z]+Error$/.test(name) ? ` (${name})` : '';
    return `${label} · failed${detail}`;
  });
}

async function withTimeout<T>(work: Promise<T>, ms = 4000): Promise<T> {
  let timer: number | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => reject(new DOMException('Test timed out', 'TimeoutError')), ms);
    })]);
  } finally {
    window.clearTimeout(timer);
  }
}

function createFrameRenderer() {
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const context = canvas.getContext('2d');
  if (!context) return null;

  const source = document.createElement('canvas');
  source.width = WIDTH;
  source.height = HEIGHT;
  const sourceContext = source.getContext('2d');
  if (!sourceContext) return null;
  const gradient = sourceContext.createLinearGradient(0, 0, WIDTH, HEIGHT);
  gradient.addColorStop(0, '#163572');
  gradient.addColorStop(1, '#f59139');
  sourceContext.fillStyle = gradient;
  sourceContext.fillRect(0, 0, WIDTH, HEIGHT);

  const draw = (frame: number) => {
    context.drawImage(source, frame * 2, 0, WIDTH - 50, HEIGHT, 0, 0, WIDTH, HEIGHT);
    context.fillStyle = '#fff';
    context.fillRect(frame * 24, 210, 90, 90);
  };
  draw(0);
  return { canvas, context, draw };
}

type FrameRenderer = NonNullable<ReturnType<typeof createFrameRenderer>>;

async function testDecodedVideo({ context }: FrameRenderer) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('aria-hidden', 'true');
  video.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;pointer-events:none';
  document.body.append(video);
  try {
    await withTimeout(new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new DOMException('Test clip could not decode', 'NotSupportedError'));
      video.src = clipUrl;
      video.load();
    }));
    // A few browsers make decoded pixels available to canvas only after presenting a frame.
    await withTimeout(Promise.resolve(video.play()));
    if (typeof video.requestVideoFrameCallback === 'function') {
      await withTimeout(new Promise<void>((resolve) => video.requestVideoFrameCallback(() => resolve())), 1000)
        .catch(() => { /* The short clip may have already presented its final frame. */ });
    }
    context.clearRect(0, 0, WIDTH, HEIGHT);
    context.drawImage(video, 0, 0, video.videoWidth, video.videoHeight, 0, 0, WIDTH, HEIGHT);
    const pixels = context.getImageData(0, 0, WIDTH, HEIGHT).data;
    const hasPicture = pixels.some((value, index) => index % 4 !== 3 && value > 32);
    return hasPicture
      ? `decoded VP8 frame read and scaled from ${video.videoWidth} × ${video.videoHeight} to ${WIDTH} × ${HEIGHT}`
      : 'decoded frame read back blank';
  } finally {
    video.pause();
    video.onloadeddata = null;
    video.onerror = null;
    video.removeAttribute('src');
    video.load();
    video.remove();
  }
}

async function testVideoEncoder({ canvas, draw }: FrameRenderer) {
  if (typeof VideoEncoder !== 'function' || typeof VideoFrame !== 'function') return 'API unavailable';
  const config: VideoEncoderConfig = {
    codec: AVC, width: WIDTH, height: HEIGHT, framerate: FPS, bitrate: 1_500_000,
    latencyMode: 'realtime',
  };
  if (!(await withTimeout(VideoEncoder.isConfigSupported(config))).supported) return `${AVC} configuration unsupported`;

  let frames = 0;
  let bytes = 0;
  const encoder = new VideoEncoder({
    output: (chunk) => { frames++; bytes += chunk.byteLength; },
    error: () => { /* flush() reports the failure. */ },
  });
  try {
    encoder.configure(config);
    const started = performance.now();
    for (let i = 0; i < FPS; i++) {
      draw(i);
      const frame = new VideoFrame(canvas, { timestamp: i * 1_000_000 / FPS });
      try { encoder.encode(frame, { keyFrame: i === 0 }); } finally { frame.close(); }
    }
    await withTimeout(encoder.flush());
    const elapsed = Math.max(1, performance.now() - started);
    if (!bytes) return 'no encoded output';
    return `${frames}/${FPS} frames encoded at ${WIDTH} × ${HEIGHT} in ${Math.round(elapsed)} ms (${Math.round(frames * 1000 / elapsed)} fps), ${bytes} bytes`;
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
}

async function testAudioTranscode(): Promise<string[]> {
  if (typeof AudioDecoder !== 'function' || typeof EncodedAudioChunk !== 'function') {
    return ['MP3 decode (WebCodecs) · API unavailable', 'MP3 → AAC (WebCodecs) · unavailable'];
  }
  const source = { codec: 'mp3', sampleRate: SAMPLE_RATE, numberOfChannels: 1 };
  if (!(await withTimeout(AudioDecoder.isConfigSupported(source))).supported) {
    return ['MP3 decode (WebCodecs) · configuration unsupported', 'MP3 → AAC (WebCodecs) · no MP3 samples available'];
  }

  const samples: AudioData[] = [];
  const decoder = new AudioDecoder({ output: (data) => samples.push(data), error: () => { /* flush() reports the failure. */ } });
  try {
    // Vite inlines this generated test tone. It holds 192-byte MPEG-1 Layer III frames at 48 kHz.
    const encoded = atob(toneUrl.slice(toneUrl.indexOf(',') + 1));
    const bytes = Uint8Array.from(encoded, (value) => value.charCodeAt(0));
    const decode = await result('MP3 decode (WebCodecs)', async () => {
      decoder.configure(source);
      const started = performance.now();
      for (let offset = 0; offset < bytes.length; offset += 192) {
        decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: offset / 192 * 24000, data: bytes.subarray(offset, offset + 192) }));
      }
      await withTimeout(decoder.flush());
      const frames = samples.reduce((total, sample) => total + sample.numberOfFrames, 0);
      return frames ? `${frames} PCM samples in ${Math.round(performance.now() - started)} ms` : 'no decoded output';
    });
    if (decoder.state !== 'closed') decoder.close();
    if (!samples.length) return [decode, 'MP3 → AAC (WebCodecs) · no MP3 samples available'];

    const encode = await result('MP3 → AAC (WebCodecs)', async () => {
      if (typeof AudioEncoder !== 'function') return 'AudioEncoder unavailable';
      const config = { ...source, codec: AAC, bitrate: 96000 };
      if (!(await withTimeout(AudioEncoder.isConfigSupported(config))).supported) return 'AAC-LC encoding unsupported';
      let outputBytes = 0;
      let chunks = 0;
      const encoder = new AudioEncoder({
        output: (chunk) => { chunks++; outputBytes += chunk.byteLength; },
        error: () => { /* flush() reports the failure. */ },
      });
      try {
        encoder.configure(config);
        const started = performance.now();
        for (const sample of samples) encoder.encode(sample);
        await withTimeout(encoder.flush());
        return outputBytes ? `${chunks} AAC packets in ${Math.round(performance.now() - started)} ms, ${outputBytes} bytes` : 'no encoded output';
      } finally {
        if (encoder.state !== 'closed') encoder.close();
      }
    });
    return [decode, encode];
  } finally {
    if (decoder.state !== 'closed') decoder.close();
    for (const sample of samples) sample.close();
  }
}

async function testRecorder({ canvas, draw }: FrameRenderer, mimeType: string) {
  const stream = canvas.captureStream(FPS);
  let timer: number | undefined;
  let recorder: MediaRecorder | undefined;
  try {
    recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 1_500_000 });
    const activeRecorder = recorder;
    const bytes = await withTimeout(new Promise<number>((resolve, reject) => {
      let size = 0;
      activeRecorder.ondataavailable = ({ data }) => { size += data.size; };
      activeRecorder.onerror = () => reject(new Error('Recording failed'));
      activeRecorder.onstop = () => resolve(size);
      activeRecorder.start();
      let frame = 0;
      timer = window.setInterval(() => {
        if (frame < FPS) draw(frame++);
        else if (activeRecorder.state === 'recording') activeRecorder.stop();
      }, 1000 / FPS);
    }));
    return bytes ? `${bytes} bytes from a ${WIDTH} × ${HEIGHT} canvas` : 'no recorded output';
  } finally {
    window.clearInterval(timer);
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    for (const track of stream.getTracks()) track.stop();
  }
}

export async function runDeviceMediaTest() {
  const lines = [
    `Secure context · ${window.isSecureContext ? 'yes' : 'no (try the test over trusted HTTPS for WebCodecs)'}`,
    `WebCodecs APIs · VideoDecoder ${typeof VideoDecoder === 'function' ? 'yes' : 'no'} · VideoEncoder ${typeof VideoEncoder === 'function' ? 'yes' : 'no'} · AudioDecoder ${typeof AudioDecoder === 'function' ? 'yes' : 'no'} · AudioEncoder ${typeof AudioEncoder === 'function' ? 'yes' : 'no'}`,
    `WebAssembly · ${typeof WebAssembly === 'object' ? 'available' : 'unavailable'}`,
  ];
  const renderer = createFrameRenderer();
  if (renderer) {
    lines.push(await result('Canvas crop, scale, overlay and pixel readback', async () => {
      const started = performance.now();
      for (let frame = 0; frame < FPS; frame++) {
        renderer.draw(frame);
        renderer.context.getImageData(0, 0, WIDTH, HEIGHT);
      }
      const elapsed = Math.max(1, performance.now() - started);
      return `${FPS} synthetic frames at ${WIDTH} × ${HEIGHT} in ${Math.round(elapsed)} ms (${Math.round(FPS * 1000 / elapsed)} fps)`;
    }));
    lines.push(await result('Decoded video → canvas', () => testDecodedVideo(renderer)));
    lines.push(await result('H.264 encode (WebCodecs)', () => testVideoEncoder(renderer)));
    if (typeof MediaRecorder !== 'function' || typeof renderer.canvas.captureStream !== 'function') {
      lines.push('Canvas recording (MediaRecorder) · API unavailable');
    } else {
      for (const [format, types] of [
        ['MP4', [`video/mp4;codecs=${AVC}`, 'video/mp4']],
        ['WebM', ['video/webm;codecs=vp8', 'video/webm']],
      ] as const) {
        const mimeType = types.find((type) => MediaRecorder.isTypeSupported?.(type));
        lines.push(mimeType
          ? await result(`Canvas recording (${mimeType})`, () => testRecorder(renderer, mimeType))
          : `Canvas recording (${format}) · format unsupported`);
      }
    }
  } else {
    lines.push('Canvas 2D · unavailable');
  }
  try {
    lines.push(...await testAudioTranscode());
  } catch (error) {
    lines.push(await result('MP3 decode (WebCodecs)', () => Promise.reject(error)));
  }
  return lines;
}
