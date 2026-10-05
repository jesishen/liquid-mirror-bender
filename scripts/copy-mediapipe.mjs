// Copies MediaPipe's WASM runtime into /public so it's served from your own domain
// (no third-party CDN at runtime). Runs automatically after `npm install`.
import { cpSync, mkdirSync } from "node:fs";
const src = "node_modules/@mediapipe/tasks-vision/wasm";
const dest = "public/mediapipe/wasm";
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log("Copied MediaPipe wasm →", dest);
