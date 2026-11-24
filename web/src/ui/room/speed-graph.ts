// One transfer's speed over the bytes done, drawn as an area in a 100 by 40 viewBox scaled to the peak so far.

/** One bucket per percent of the file, one viewBox unit wide. */
const BUCKETS = 100;
const HEIGHT = 40;
/** The newest speed's weight against the one before, so speeds measured 250 ms apart do not draw spikes. */
const SMOOTHING = 0.5;

export class SpeedGraph {
  private readonly speeds = new Float64Array(BUCKETS);
  private filled = 0;
  private current = 0;
  private peak = 0;
  /** The fraction of the file done at the last `add`. */
  public fraction = 0;

  /** Records `bytesPerSecond` for the buckets crossed up to `fraction`; a render that skipped buckets fills them all. */
  public add(fraction: number, bytesPerSecond: number): void {
    this.current = this.filled ? this.current + (bytesPerSecond - this.current) * SMOOTHING : bytesPerSecond;
    this.peak = Math.max(this.peak, this.current);
    this.fraction = fraction;

    const end = Math.min(BUCKETS, Math.ceil(fraction * BUCKETS));
    this.speeds.fill(this.current, this.filled, end);
    this.filled = Math.max(this.filled, end);
  }

  /** The current speed as a fraction of the peak, 0 to 1. */
  public height(): number {
    return this.peak ? this.current / this.peak : 0;
  }

  /** The area's outline: a line through the bucket centres at speed / peak, closed along the bottom. */
  public path(): string {
    if (!this.filled || !this.peak) return "";

    const points = Array.from(this.speeds.subarray(0, this.filled), (speed, i) => `L${i + 0.5},${this.y(speed)}`);
    const last = this.y(this.speeds[this.filled - 1]);

    return `M0,${HEIGHT}L0,${this.y(this.speeds[0])}${points.join("")}L${this.filled},${last}L${this.filled},${HEIGHT}Z`;
  }

  /** The peak sits one unit below the top, so the outline's stroke there is not cut off. */
  private y(speed: number): number {
    return Math.round((1 + (1 - speed / this.peak) * (HEIGHT - 1)) * 100) / 100;
  }
}
