import type { WaterInput } from "./water";

/**
 * Turns fingertip positions into water interactions.
 *
 *  - finger held still → bobs gently in the water, sending out a smooth,
 *                        continuous train of rings (no sudden pulses)
 *  - finger moving     → no rings; pushes a wake and drags the water along
 *  - stops moving      → rings fade back in smoothly
 */

export type TipPoint = { key: string; x: number; y: number }; // screen uv, y down

export const TUNING = {
  radius: 0.02,           // fingertip size (fraction of screen height)
  rippleAmp: 0.14,        // how deep each ring is (bigger = more dramatic rings)
  rippleHz: 2.2,          // rings per second
  rippleFadeIn: 0.35,     // seconds for rings to come back after a drag stops
  stillSpeed: 0.1,        // screen-heights/sec below which a finger counts as still
  stillDelay: 0.4,        // seconds a finger must stay still before rings start       // screen-heights/sec below which a finger counts as still
  pressPerSpeed: 0.04,    // wake strength while dragging
  maxPress: 0.05,
  drag: 2.5,              // how much water gets dragged along (liquify)
  lostAfterMs: 180,       // a finger missing this long lifts out of the water
  jump: 0.22,             // bigger jumps between frames = a different finger (no streak)
  flickSpeed: 0,        // faster than this (screen-heights/sec) = a flick
  splashAmp: 2.2,         // how big the flick splash is
  splashRadius: 0.035,    // splash size
  splashCooldownMs: 450,  // min time between splashes from one finger
};

/** What happened this frame — used for sound. */
export type FingerEvents = {
  drips: { x: number }[];     // a still finger sent out a ring
  splashes: { x: number }[];  // a flick
  dragSpeed: number;          // fastest dragging finger (0 = none)
};

class LowPass {
  y: number | null = null;
  filter(x: number, a: number) {
    this.y = this.y === null ? x : this.y + a * (x - this.y);
    return this.y;
  }
}

class OneEuro {
  private x = new LowPass();
  private dx = new LowPass();
  private last: number | null = null;
  constructor(private minCutoff = 1.6, private beta = 18, private dCutoff = 1) {}
  private alpha(cutoff: number, dt: number) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(v: number, dt: number) {
    const prev = this.last ?? v;
    const dv = (v - prev) / dt;
    const edv = this.dx.filter(dv, this.alpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(edv);
    this.last = this.x.filter(v, this.alpha(cutoff, dt));
    return this.last;
  }
}

type Track = {
  x: number; y: number;
  fx: OneEuro; fy: OneEuro;
  lastSeen: number;
  phase: number;     // where the finger is in its gentle bob (radians)
  stillness: number; // 0 = dragging, 1 = fully still (rings at full strength)
  lastSplash: number;
  speed: number;     // smoothed (camera runs at ~30fps, screen at 60+)
};
export class FingerField {
  private tracks = new Map<string, Track>();
  events: FingerEvents = { drips: [], splashes: [], dragSpeed: 0 };

  update(points: TipPoint[], now: number, dt: number, aspect: number): WaterInput[] {
    const out: WaterInput[] = [];
    const seen = new Set<string>();
    const sdt = Math.max(dt, 1 / 240);
    const frameScale = Math.min(1, dt * 60); // same strength at 60Hz and 120Hz
    const ev: FingerEvents = (this.events = { drips: [], splashes: [], dragSpeed: 0 });

    for (const pt of points) {
      seen.add(pt.key);
      let t = this.tracks.get(pt.key);
      const jumped = t && Math.hypot((pt.x - t.x) * aspect, pt.y - t.y) > TUNING.jump;

      if (!t || now - t.lastSeen > TUNING.lostAfterMs || jumped) {
        t = {
          x: pt.x, y: pt.y,
          fx: new OneEuro(), fy: new OneEuro(),
          lastSeen: now, phase: 0, stillness: 0, lastSplash: now, speed: 0, // eases in
        };
        t.fx.filter(pt.x, sdt);
        t.fy.filter(pt.y, sdt);
        this.tracks.set(pt.key, t);
      }

      const px = t.x, py = t.y;
      const x = t.fx.filter(pt.x, sdt);
      const y = t.fy.filter(pt.y, sdt);
      const rawSpeed = Math.hypot((x - px) * aspect, y - py) / sdt;
      t.speed += (rawSpeed - t.speed) * 0.5;
      const speed = t.speed;
      const moving = speed >= TUNING.stillSpeed;

      // rings switch off while dragging, fade back in when still
      t.stillness = moving ? 0 : Math.min(1, t.stillness + sdt / TUNING.rippleFadeIn);
      const cycle = Math.floor(t.phase / (Math.PI * 2));
      t.phase += sdt * TUNING.rippleHz * Math.PI * 2;
      if (Math.floor(t.phase / (Math.PI * 2)) !== cycle && t.stillness > 0.8) ev.drips.push({ x });
      if (moving) ev.dragSpeed = Math.max(ev.dragSpeed, speed);

      // a fast flick → one big splash
      let splash = 0;
      if (speed > TUNING.flickSpeed && now - t.lastSplash > TUNING.splashCooldownMs) {
        splash = TUNING.splashAmp;
        t.lastSplash = now;
        ev.splashes.push({ x });
      }

      // smooth up-and-down bob → continuous rings
      const pulse = Math.sin(t.phase) * TUNING.rippleAmp * t.stillness * frameScale;
      const press = moving
        ? Math.min(TUNING.maxPress, speed * TUNING.pressPerSpeed) * frameScale
        : 0;

      t.x = x;
      t.y = y;
      t.lastSeen = now;
        out.push({
        x, y, px, py,
        pulse: pulse + splash,
        press,
        drag: TUNING.drag,
        radius: splash ? TUNING.splashRadius : TUNING.radius,
      });
    }

    for (const [k, t] of this.tracks) {
      if (!seen.has(k) && now - t.lastSeen > TUNING.lostAfterMs) this.tracks.delete(k);
    }
    return out;
  }
}