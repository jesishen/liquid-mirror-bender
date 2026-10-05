import type { HandLandmarker, NormalizedLandmark } from "@mediapipe/tasks-vision";
import { sourceToScreen, type Crop } from "./water";
import type { TipPoint } from "./fingers";

const WASM_PATH = "/mediapipe/wasm"; // copied into /public by scripts/copy-mediapipe.mjs
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

export const FINGERTIPS = [4, 8, 12, 16, 20]; // thumb, index, middle, ring, pinky

export type Connection = { start: number; end: number };

export async function loadHandTracker(cpuOnly = false): Promise<{
  landmarker: HandLandmarker;
  connections: Connection[];
}> {
  const { FilesetResolver, HandLandmarker } = await import("@mediapipe/tasks-vision");
  const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
  const make = (delegate: "GPU" | "CPU") =>
    HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: "VIDEO",
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  let landmarker: HandLandmarker;
  try {
    if (cpuOnly) throw new Error("cpu");
    landmarker = await make("GPU");
  } catch {
    landmarker = await make("CPU"); // some phones/browsers have no GPU delegate
  }
  return { landmarker, connections: HandLandmarker.HAND_CONNECTIONS };
}

/** Hands mapped into screen uv with the SAME crop as the image. */
export function handsToScreen(
  hands: NormalizedLandmark[][],
  crop: Crop,
  mirror: boolean
) {
  return hands.map((lm) => lm.map((p) => sourceToScreen(p.x, p.y, crop, mirror)));
}

type P = { x: number; y: number };
const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y);
const PIP: Record<number, number> = { 8: 6, 12: 10, 16: 14, 20: 18 };

/** A finger is "out" when its tip is clearly farther from the wrist than its middle joint. */
function isExtended(hand: P[], tip: number) {
  if (tip === 4) {
    // thumb: tip pulled away from the index knuckle
    return dist(hand[4], hand[5]) > dist(hand[0], hand[5]) * 0.6 &&
           dist(hand[4], hand[9]) > dist(hand[3], hand[9]);
  }
  return dist(hand[tip], hand[0]) > dist(hand[PIP[tip]], hand[0]) * 1.15;
}

export function fingertipPoints(screenHands: { x: number; y: number }[][]): TipPoint[] {
  const pts: TipPoint[] = [];
  screenHands.forEach((hand, h) => {
    for (const i of FINGERTIPS) {
      if (!isExtended(hand, i)) continue; // curled finger / fist = no ripples
      const p = hand[i];
      // fingertips cropped off-screen don't touch the water
      if (p.x < -0.02 || p.x > 1.02 || p.y < -0.02 || p.y > 1.02) continue;
      pts.push({ key: `h${h}-${i}`, x: p.x, y: p.y });
    }
  });
  return pts;
}

/** The optional skeleton overlay, drawn on a 2D canvas above the water. */
export function drawSkeleton(
  ctx: CanvasRenderingContext2D,
  screenHands: { x: number; y: number }[][],
  connections: Connection[]
) {
  const { width: w, height: h } = ctx.canvas;
  ctx.clearRect(0, 0, w, h);
  const s = Math.max(1, Math.min(w, h) / 500);
  ctx.lineCap = "round";
  for (const hand of screenHands) {
    ctx.strokeStyle = "rgba(255,255,255,0.75)";
    ctx.lineWidth = 2.2 * s;
    ctx.beginPath();
    for (const c of connections) {
      ctx.moveTo(hand[c.start].x * w, hand[c.start].y * h);
      ctx.lineTo(hand[c.end].x * w, hand[c.end].y * h);
    }
    ctx.stroke();
    hand.forEach((p, i) => {
      const tip = FINGERTIPS.includes(i);
      ctx.beginPath();
      ctx.arc(p.x * w, p.y * h, (tip ? 5 : 3) * s, 0, Math.PI * 2);
      ctx.fillStyle = tip ? "#ffffff" : "rgba(255,255,255,0.85)";
      ctx.fill();
      if (tip) {
        ctx.lineWidth = 1.5 * s;
        ctx.strokeStyle = "rgba(0,0,0,0.35)";
        ctx.stroke();
      }
    });
  }
}
