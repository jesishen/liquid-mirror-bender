/**
 * Photo + video capture of exactly what's on screen
 * (water, plus the skeleton when it's switched on).
 */

export type Capture = { kind: "photo" | "video"; blob: Blob; url: string; ext: string };

const MAX_LONG_SIDE = 1920;

export function makeCompositor(water: HTMLCanvasElement, overlay: HTMLCanvasElement) {
  const out = document.createElement("canvas");
  const ctx = out.getContext("2d")!;
  const draw = (withOverlay: boolean) => {
    const scale = Math.min(1, MAX_LONG_SIDE / Math.max(water.width, water.height));
    const w = Math.round((water.width * scale) / 2) * 2; // even sizes for encoders
    const h = Math.round((water.height * scale) / 2) * 2;
    if (out.width !== w || out.height !== h) {
      out.width = w;
      out.height = h;
    }
    ctx.drawImage(water, 0, 0, w, h);
    if (withOverlay) ctx.drawImage(overlay, 0, 0, w, h);
  };
  return { canvas: out, draw };
}

export function takePhoto(canvas: HTMLCanvasElement): Promise<Capture> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve({ kind: "photo", blob, url: URL.createObjectURL(blob), ext: "png" })
          : reject(new Error("Couldn't capture the photo.")),
      "image/png"
    )
  );
}

function pickMime(withAudio = false) {
  const options = withAudio
    ? [
        "video/mp4;codecs=avc1,mp4a.40.2",
        "video/mp4",
        "video/webm;codecs=vp9,opus",
        "video/webm;codecs=vp8,opus",
        "video/webm",
      ]
    : [
        "video/mp4;codecs=avc1",
        "video/mp4",
        "video/webm;codecs=vp9",
        "video/webm;codecs=vp8",
        "video/webm",
      ];
  return options.find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m));
}

export function canRecord() {
  return typeof MediaRecorder !== "undefined" && !!pickMime();
}

export function startRecording(canvas: HTMLCanvasElement, audio?: MediaStream) {
  const stream = canvas.captureStream(30);
  const audioTrack = audio?.getAudioTracks()[0];
  let mimeType = pickMime(!!audioTrack);
  let rec: MediaRecorder;
  try {
    if (!audioTrack || !mimeType) throw new Error("no audio");
    stream.addTrack(audioTrack.clone());
    rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
  } catch {
    // browser can't record audio with video → video only
    stream.getAudioTracks().forEach((t) => { stream.removeTrack(t); t.stop(); });
    mimeType = pickMime()!;
    rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
  }
  const finalMime = mimeType!;
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.start(250);
  const done = new Promise<Capture>((resolve) => {
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: finalMime.split(";")[0] });
      const ext = finalMime.includes("mp4") ? "mp4" : "webm";
      resolve({ kind: "video", blob, url: URL.createObjectURL(blob), ext });
    };
  });
  return { stop: () => rec.state !== "inactive" && rec.stop(), done };
}

/** Phones: native share sheet (→ "Save Image/Video"). Desktop: download. */
export async function saveCapture(c: Capture) {
  const name = `surface-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.${c.ext}`;
  const file = new File([c.blob], name, { type: c.blob.type });
  const touch = window.matchMedia("(pointer: coarse)").matches;
  if (touch && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
    }
  }
  const a = document.createElement("a");
  a.href = c.url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
