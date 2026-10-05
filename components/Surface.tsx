"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { HandLandmarker, NormalizedLandmark } from "@mediapipe/tasks-vision";
import { WaterEngine } from "@/lib/water";
import { FingerField, type TipPoint } from "@/lib/fingers";
import { loadHandTracker, handsToScreen, fingertipPoints, drawSkeleton, type Connection } from "@/lib/hands";
import {
  openCamera, stopStream, shouldMirror, hasMultipleCameras, makeFallbackSource,
  isTouchDevice, isPortrait, type Facing,
} from "@/lib/camera";
import {
  makeCompositor, takePhoto, startRecording, saveCapture, canRecord, type Capture,
} from "@/lib/capture";

type Phase = "intro" | "starting" | "live" | "error";
type Tracker = "loading" | "ready" | "failed" | "off";
type Mode = "photo" | "video";

const SKELETON_DEFAULT = true; // ← flip to false to start with the skeleton hidden
const MAX_RECORD_SECONDS = 60;

export default function Surface() {
  const [phase, setPhase] = useState<Phase>("intro");
  const [error, setError] = useState("");
  const [tracker, setTracker] = useState<Tracker>("loading");
  const [noCamera, setNoCamera] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const [skeleton, setSkeleton] = useState(SKELETON_DEFAULT);
  const [mode, setMode] = useState<Mode>("photo");
  const [videoOk, setVideoOk] = useState(true);
  const [recording, setRecording] = useState(false);
  const [recordSecs, setRecordSecs] = useState(0);
  const [flash, setFlash] = useState(false);
  const [last, setLast] = useState<Capture | null>(null);
  const [preview, setPreview] = useState(false);
  const [canFlip, setCanFlip] = useState(false);

  const stageRef = useRef<HTMLDivElement>(null);
  const waterRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const engine = useRef<WaterEngine | null>(null);
  const fingers = useRef(new FingerField());
  const hands = useRef<{ landmarker: HandLandmarker; connections: Connection[] } | null>(null);
  const lastHands = useRef<NormalizedLandmark[][]>([]);
  const lastVideoTime = useRef(-1);
  const lastHandSeen = useRef(0);
  const stream = useRef<MediaStream | null>(null);
  const facing = useRef<Facing>("user");
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const skeletonOn = useRef(SKELETON_DEFAULT);
  const overlayDirty = useRef(false);
  const compositor = useRef<ReturnType<typeof makeCompositor> | null>(null);
  const recorder = useRef<ReturnType<typeof startRecording> | null>(null);
  const raf = useRef(0);
  const lastFrame = useRef(0);
  const needsLayout = useRef(true);
  const hintShown = useRef(false);
  const recovering = useRef(false);

  useEffect(() => {
    skeletonOn.current = skeleton;
    overlayDirty.current = true;
  }, [skeleton]);

  // ---------- layout: canvas always matches the screen, any device, any orientation
  const layout = useCallback(() => {
    const stage = stageRef.current, e = engine.current, ov = overlayRef.current;
    if (!stage || !e || !ov) return;
    const { width, height } = stage.getBoundingClientRect();
    const touch = isTouchDevice();
    const dpr = Math.min(window.devicePixelRatio || 1, touch ? 2 : 1.5);
    e.resize(width, height, dpr, touch ? 320 : 448);
    if (ov.width !== e.canvas.width || ov.height !== e.canvas.height) {
      ov.width = e.canvas.width;
      ov.height = e.canvas.height;
    }
  }, []);

  // ---------- camera
  const attachCamera = useCallback(async (face: Facing) => {
    const video = videoRef.current!;
    stopStream(stream.current);
    stream.current = null;
    const s = await openCamera(face);
    stream.current = s;
    facing.current = face;
    video.srcObject = s;
    await video.play();
    engine.current?.setSource(video, shouldMirror(s, face));
    lastVideoTime.current = -1;
  }, []);

  const switchToFallback = useCallback(() => {
    setNoCamera(true);
    setTracker("off");
    engine.current?.setSource(makeFallbackSource(1280, 1280), false);
  }, []);

  // ---------- the frame loop
  const frame = useCallback((now: number) => {
    raf.current = requestAnimationFrame(frame);
    const e = engine.current;
    if (!e) return;
    if (needsLayout.current) {
      needsLayout.current = false;
      layout();
    }
    const dt = lastFrame.current ? Math.min((now - lastFrame.current) / 1000, 0.1) : 1 / 60;
    lastFrame.current = now;

    // 1. hands
    const video = videoRef.current;
    const h = hands.current;
    if (h && video && video.readyState >= 2 && video.currentTime !== lastVideoTime.current) {
      lastVideoTime.current = video.currentTime;
      try {
        lastHands.current = h.landmarker.detectForVideo(video, now).landmarks;
      } catch {
        lastHands.current = [];
        // MediaPipe crashed (usually its GPU mode) → restart it on the CPU
        if (!recovering.current) {
          recovering.current = true;
          const dead = hands.current;
          hands.current = null;
          try { dead?.landmarker.close(); } catch { /* already dead */ }
          loadHandTracker(true)
            .then((fresh) => { hands.current = fresh; })
            .catch(() => setTracker("failed"))
            .finally(() => { recovering.current = false; });
        }
      }
    }
    const screenHands = handsToScreen(lastHands.current, e.crop, e.isMirrored);
    if (screenHands.length) lastHandSeen.current = now;

    // 2. every visible fingertip + any touch/mouse presses
    const points: TipPoint[] = fingertipPoints(screenHands);
    pointers.current.forEach((p, id) => points.push({ key: `p${id}`, x: p.x, y: p.y }));
    const aspect = e.canvas.width / e.canvas.height;
    const inputs = fingers.current.update(points, now, dt, aspect);

    // 3. water
    e.step(inputs, dt);
    e.draw();

    // 4. skeleton overlay
    const ov = overlayRef.current;
    if (ov && h) {
      const ctx = ov.getContext("2d")!;
      if (skeletonOn.current) {
        drawSkeleton(ctx, screenHands, h.connections);
        overlayDirty.current = true;
      } else if (overlayDirty.current) {
        ctx.clearRect(0, 0, ov.width, ov.height);
        overlayDirty.current = false;
      }
    }

    // 5. recording follows exactly what's on screen
    if (recorder.current && compositor.current) compositor.current.draw(skeletonOn.current);

    // 6. "hold your hand up" hint
    const wantHint = !!h && now - lastHandSeen.current > 1500 && pointers.current.size === 0;
    if (wantHint !== hintShown.current) {
      hintShown.current = wantHint;
      setShowHint(wantHint);
    }
  }, [layout]);

  // ---------- start
  const start = useCallback(async () => {
    setPhase("starting");
    try {
      engine.current = new WaterEngine(waterRef.current!);
    } catch (err) {
      setError((err as Error).message);
      setPhase("error");
      return;
    }
    compositor.current = makeCompositor(waterRef.current!, overlayRef.current!);
    setVideoOk(canRecord());
    needsLayout.current = true;
    lastHandSeen.current = performance.now();
    raf.current = requestAnimationFrame(frame);

    try {
      await attachCamera("user");
      setPhase("live");
      hasMultipleCameras().then(setCanFlip);
      loadHandTracker()
        .then((h) => {
          hands.current = h;
          lastHandSeen.current = performance.now();
          setTracker("ready");
        })
        .catch(() => setTracker("failed"));
    } catch {
      switchToFallback();
      setPhase("live");
    }
  }, [attachCamera, frame, switchToFallback]);

  // ---------- resize / rotate / background tab
  useEffect(() => {
    if (phase !== "live" && phase !== "starting") return;
    const stage = stageRef.current!;
    let rotateTimer = 0;
    const ro = new ResizeObserver(() => {
      needsLayout.current = true;
      // Phone rotated? Re-ask the camera for a stream shaped like the new screen.
      if (!isTouchDevice() || !stream.current) return;
      clearTimeout(rotateTimer);
      rotateTimer = window.setTimeout(() => {
        const v = videoRef.current;
        if (!v?.videoWidth || recorder.current) return;
        const streamPortrait = v.videoHeight > v.videoWidth;
        if (streamPortrait !== isPortrait()) attachCamera(facing.current).catch(() => {});
      }, 500);
    });
    ro.observe(stage);

    const onVis = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf.current);
        if (recorder.current) stopVideo();
      } else {
        lastFrame.current = 0;
        raf.current = requestAnimationFrame(frame);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      ro.disconnect();
      clearTimeout(rotateTimer);
      document.removeEventListener("visibilitychange", onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, attachCamera, frame]);

  useEffect(() => () => {
    cancelAnimationFrame(raf.current);
    stopStream(stream.current);
    hands.current?.landmarker.close();
    engine.current?.dispose();
  }, []);

  // ---------- touch / mouse also touch the water
  const toUv = (e: React.PointerEvent) => {
    const r = stageRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };
  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, toUv(e));
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, toUv(e));
  };
  const onPointerUp = (e: React.PointerEvent) => pointers.current.delete(e.pointerId);

  // ---------- capture
  const keep = (c: Capture) =>
    setLast((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return c;
    });

  const shootPhoto = async () => {
    const comp = compositor.current;
    if (!comp) return;
    comp.draw(skeletonOn.current);
    setFlash(true);
    setTimeout(() => setFlash(false), 180);
    keep(await takePhoto(comp.canvas));
  };

  const stopVideo = () => {
    const r = recorder.current;
    if (!r) return;
    recorder.current = null;
    r.stop();
    setRecording(false);
    r.done.then(keep);
  };

  const startVideo = () => {
    const comp = compositor.current;
    if (!comp) return;
    comp.draw(skeletonOn.current);
    recorder.current = startRecording(comp.canvas);
    setRecordSecs(0);
    setRecording(true);
  };

  useEffect(() => {
    if (!recording) return;
    const t0 = Date.now();
    const id = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      setRecordSecs(s);
      if (s >= MAX_RECORD_SECONDS) stopVideo();
    }, 250);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);

  const onShutter = () => {
    if (mode === "photo") shootPhoto();
    else if (recording) stopVideo();
    else startVideo();
  };

  const flipCamera = async () => {
    if (recording) return;
    try {
      await attachCamera(facing.current === "user" ? "environment" : "user");
    } catch {
      /* keep current camera */
    }
  };

  const timer = `${String(Math.floor(recordSecs / 60)).padStart(2, "0")}:${String(recordSecs % 60).padStart(2, "0")}`;

  const status =
    noCamera ? "Camera unavailable — touch or drag to make ripples"
    : tracker === "loading" ? "Loading hand tracking…"
    : tracker === "failed" ? "Hand tracking couldn't load — touch the screen instead"
    : "";

  return (
    <main className="surface">
      <div
        ref={stageRef}
        className="stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <canvas ref={waterRef} className="layer" />
        <canvas ref={overlayRef} className="layer overlay" />
      </div>
      <video ref={videoRef} className="hidden-video" playsInline muted autoPlay />
      {flash && <div className="flash" />}

      {phase === "intro" && (
        <section className="intro">
          <div className="rings" aria-hidden>
            <span /><span /><span />
          </div>
          <h1>Caution: Your screen will turn into liquid! :O</h1>
          <p>ofc im jk if you&apos;re scared btw</p>
          <button className="start" onClick={start}>Start camera</button>
          <small>Designed and developed by Jessica Shen</small>
        </section>
      )}

      {phase === "starting" && (
        <section className="intro dim"><p>Waiting for camera…</p></section>
      )}

      {phase === "error" && (
        <section className="intro">
          <h1>Hmm.</h1>
          <p>{error}</p>
          <small>Try the latest Chrome or Safari.</small>
        </section>
      )}

      {phase === "live" && (
        <>
          <div className="top">
            {recording ? (
              <div className="timer"><i />{timer}</div>
            ) : status ? (
              <div className="pill">{status}</div>
            ) : <div />}
            {!noCamera && (
              <button
                className={`round ${skeleton ? "on" : ""}`}
                onClick={() => setSkeleton((s) => !s)}
                aria-pressed={skeleton}
                aria-label={skeleton ? "Hide hand skeleton" : "Show hand skeleton"}
                title="Hand skeleton"
              >
                <HandIcon />
              </button>
            )}
          </div>

          {showHint && !recording && <div className="hint">Hold your hand up to touch the water ✋</div>}

          <div className="controls">
            {videoOk && (
              <div className="modes" role="tablist">
                {(["video", "photo"] as Mode[]).map((m) => (
                  <button
                    key={m}
                    role="tab"
                    aria-selected={mode === m}
                    className={mode === m ? "sel" : ""}
                    disabled={recording}
                    onClick={() => setMode(m)}
                  >
                    {m}
                  </button>
                ))}
              </div>
            )}
            <div className="row">
              <button
                className="thumb"
                onClick={() => last && setPreview(true)}
                aria-label="Open last capture"
                disabled={!last || recording}
              >
                {last && (last.kind === "photo"
                  ? <img src={last.url} alt="" />
                  : <video src={last.url} muted playsInline />)}
              </button>
              <button
                className={`shutter ${mode} ${recording ? "rec" : ""}`}
                onClick={onShutter}
                aria-label={mode === "photo" ? "Take photo" : recording ? "Stop recording" : "Record video"}
              >
                <span />
              </button>
              <button
                className="round flip"
                onClick={flipCamera}
                aria-label="Switch camera"
                style={{ visibility: canFlip && !recording ? "visible" : "hidden" }}
              >
                <FlipIcon />
              </button>
            </div>
          </div>
        </>
      )}

      {preview && last && (
        <section className="preview" onClick={() => setPreview(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            {last.kind === "photo"
              ? <img src={last.url} alt="Your capture" />
              : <video src={last.url} controls autoPlay loop playsInline />}
            <div className="actions">
              <button onClick={() => setPreview(false)}>Close</button>
              <button className="primary" onClick={() => saveCapture(last)}>Save</button>
            </div>
          </div>
        </section>
      )}
    </main>
  );
}

function HandIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12" />
      <path d="M11 11.5v-7a1.5 1.5 0 0 1 3 0v7" />
      <path d="M14 11.5v-5a1.5 1.5 0 0 1 3 0V13" />
      <path d="M17 9.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1.5a6 6 0 0 1-4.8-2.4L4.4 15.3a1.6 1.6 0 0 1 2.4-2.1L8 14.5" />
    </svg>
  );
}

function FlipIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 11a8 8 0 0 0-14.9-3.5M4 4v4h4" />
      <path d="M4 13a8 8 0 0 0 14.9 3.5M20 20v-4h-4" />
    </svg>
  );
}
