/**
 * WaterSound — two real recordings from /public/sounds:
 *  Rain.mp3   ambient rain, always playing (loops)
 *  water.mp3  touching-water sound, fades in while a finger moves (loops)
 * `stream` carries the same audio so video recordings include it.
 * Missing files are simply skipped (silent), nothing breaks.
 */

const VOLUME = 0.9;
const RAIN_FILE = "/sounds/Rain.mp3";   // file names are case-sensitive once deployed
const WATER_FILE = "/sounds/water.mp3";
const RAIN_LEVEL = 0.35;                // rain volume (0–1)
const WATER_LEVEL = 1.0;                // touching-water volume at full speed (0–1)

export class WaterSound {
  readonly ctx: AudioContext;
  readonly stream: MediaStream;
  private master: GainNode;
  private rainGain: GainNode;
  private waterGain: GainNode;

  constructor() {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = (this.ctx = new AC());

    this.master = ctx.createGain();
    this.master.gain.value = VOLUME;
    this.master.connect(ctx.destination);
    const rec = ctx.createMediaStreamDestination();
    this.master.connect(rec);
    this.stream = rec.stream;

    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    this.rainGain.connect(this.master);

    this.waterGain = ctx.createGain();
    this.waterGain.gain.value = 0; // silent until a finger moves
    this.waterGain.connect(this.master);

    this.load();
  }

  private async loadOne(url: string): Promise<AudioBuffer | null> {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      return await this.ctx.decodeAudioData(await res.arrayBuffer());
    } catch {
      return null;
    }
  }

  private loop(buffer: AudioBuffer, into: GainNode) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.connect(into);
    src.start();
  }

  private async load() {
    const [rain, water] = await Promise.all([this.loadOne(RAIN_FILE), this.loadOne(WATER_FILE)]);
    if (rain) {
      this.loop(rain, this.rainGain);
      this.rainGain.gain.setTargetAtTime(RAIN_LEVEL, this.ctx.currentTime, 1.0); // gentle fade-in
    }
    if (water) this.loop(water, this.waterGain);
  }

  /** Must be called from a tap/click (browsers block audio until then). */
  resume() {
    if (this.ctx.state !== "running") this.ctx.resume().catch(() => {});
  }

  suspend() {
    this.ctx.suspend().catch(() => {});
  }

  setMuted(muted: boolean) {
    this.master.gain.setTargetAtTime(muted ? 0 : VOLUME, this.ctx.currentTime, 0.05);
  }

  /** Call every frame with the fastest moving finger's speed (0 when none). */
  swish(speed: number) {
    const amount = Math.max(0, Math.min(1, (speed - 0.15) / 1.2));
    // quick fade in when you move, slower fade out when you stop
    this.waterGain.gain.setTargetAtTime(amount * WATER_LEVEL, this.ctx.currentTime, amount > 0 ? 0.08 : 0.3);
  }

  // Kept so the rest of the app doesn't need changes — no separate drip/splash sounds now.
  drip(_x: number) {}
  splash(_x: number) {}
}