export type Facing = "user" | "environment";

export const isTouchDevice = () =>
  typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;

export const isPortrait = () =>
  typeof window !== "undefined" && window.innerHeight > window.innerWidth;

/**
 * Ask for a stream shaped like the screen right now.
 * Phones get a portrait stream when held upright (no awkward zoomed-in crop);
 * desktop webcams stay landscape and are cover-cropped to the window.
 */
export async function openCamera(facing: Facing): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Camera isn't available in this browser (it needs HTTPS).");
  }
  // Always ask for the camera's normal (landscape) shape. Phones rotate it to
  // portrait themselves without cropping. Asking for a portrait shape makes
  // phones crop into the sensor — that was the "zoomed in" look.
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: facing },
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    },
  });
}

export function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((t) => t.stop());
}

/** Front cameras (and desktop webcams, which report no facing) are mirrored. */
export function shouldMirror(stream: MediaStream, requested: Facing) {
  const s = stream.getVideoTracks()[0]?.getSettings();
  const facing = s?.facingMode ?? requested;
  return facing !== "environment";
}

export async function hasMultipleCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "videoinput").length > 1;
  } catch {
    return false;
  }
}

/** Stand-in "camera" when access is denied, so the water still works with touch. */
export function makeFallbackSource(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, "#0d2b3e");
  g.addColorStop(1, "#1d5f6e");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // a grid makes the distortion easy to see
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 1;
  const step = Math.round(Math.min(w, h) / 14);
  for (let x = 0; x < w; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
  for (let y = 0; y < h; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  return c;
}
