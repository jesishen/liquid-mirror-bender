# Surface

Your screen is a layer of clear water. Hold your hands up to the camera and touch it.

- **Still finger** → ripples keep spreading out from it
- **Moving finger** → pushes a wake through the water and drags it along (liquify)
- Every visible fingertip on both hands touches the water (up to 10)
- Touch / mouse also works, and is the fallback if the camera is blocked
- Hand skeleton toggle (top right), Apple-style Photo / Video capture (bottom)

## Run it

```bash
npm install      # also copies MediaPipe's wasm into /public
npm run dev      # http://localhost:3000
```

Phones need **HTTPS** for the camera. Easiest: deploy to Vercel (`vercel` or import the repo) and open the preview URL on your phone. For local phone testing: `npx next dev --experimental-https` and open the network URL.

## Where things live

| File | What it does |
| --- | --- |
| `lib/water.ts` | The water: WebGL2 heightmap sim (ripples) + drag field (liquify) + refraction render. `DEFAULT_SETTINGS` = feel of the water. |
| `lib/fingers.ts` | Turns fingertips into touches: splash on appear, rings when still, wake + drag when moving. `TUNING` = all the interaction knobs. |
| `lib/hands.ts` | MediaPipe hand tracking (2 hands), fingertip mapping, skeleton drawing. |
| `lib/camera.ts` | Camera that matches device + orientation, mirroring, fallback image. |
| `lib/capture.ts` | Photo (PNG) and video (MP4 on Safari, WebM on Chrome) of exactly what's on screen. |
| `components/Surface.tsx` | Screens, controls, frame loop. `SKELETON_DEFAULT` sets skeleton on/off at load. |

## The camera "zoom" fix (from Magical Wands)

The image is cover-cropped to the screen in the shader, and the **same crop** (`coverCrop` + `sourceToScreen` in `lib/water.ts`) maps hand landmarks to the screen, so fingertips always land exactly on your fingers. The crop is recomputed every frame, phones request a stream shaped like the screen, and rotating a phone re-requests the camera if needed.

## Tuning cheatsheet

- Ripples too subtle/strong → `stillPulse`, `touchDownPulse` (fingers.ts), `refraction` (water.ts)
- Ripples die too fast → `damping` closer to 1 (e.g. 0.993)
- Drag too melty → lower `drag` (fingers.ts) or `dispDecay` (water.ts)
- Wake too strong → `pressPerSpeed`, `maxPress`
- Bigger/smaller fingertip → `radius`
