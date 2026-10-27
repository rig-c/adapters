import type { LiveAttachment, LiveFrame, LiveNumbers, PosedClip, PosedFrame, PosedMesh, PosedRegion, PosedSlot } from '@rig-c/play';

export type DrawClip = Omit<PosedClip, 'polygon'> & { polygon: LiveNumbers };
type Common = { tint: DrawNumbers; dark?: LiveNumbers; clip?: DrawClip };
export type DrawRegion = Omit<PosedRegion, 'z' | 'corners' | 'uvs' | 'tint' | 'dark' | 'clip'> & Common & { corners: DrawNumbers; uvs: LiveNumbers };
export type DrawMesh = Omit<PosedMesh, 'z' | 'vertices' | 'uvs' | 'triangles' | 'tint' | 'dark' | 'clip' | 'sequence'> & Common & {
  vertices: DrawNumbers; uvs: LiveNumbers; triangles: LiveNumbers; sequence?: number;
};
export type DrawSlot = DrawRegion | DrawMesh;
const EMPTY: LiveNumbers = Object.freeze([]);

function numbers(value: LiveNumbers, field: string): void {
  if (!value || typeof value !== 'object' || !Number.isInteger(value.length) || value.length < 0) {
    throw new Error(`PixiRenderer: live ${field} needs an indexed buffer with nonnegative integer length`);
  }
}

/** Internal span, with no per-coordinate properties, accessors or proxies. */
export class NumberSpan {
  source: LiveNumbers = EMPTY;
  offset = 0;
  constructor(readonly count: number) {}
}

export type DrawNumbers = LiveNumbers | NumberSpan;
export function numberSource(value: DrawNumbers): LiveNumbers { return value instanceof NumberSpan ? value.source : value; }
export function numberOffset(value: DrawNumbers): number { return value instanceof NumberSpan ? value.offset : 0; }
export function numberCount(value: DrawNumbers): number { return value instanceof NumberSpan ? value.count : value.length; }

interface Row { slot: DrawSlot; points: NumberSpan; tint: NumberSpan }

/** Pooled draw views. All lease references are dropped at the end of render(). */
export class LiveDrawViews {
  readonly order: DrawSlot[] = [];
  private readonly rows: Row[] = [];

  read(frame: LiveFrame): readonly DrawSlot[] {
    void frame.generation; // Checked stale leases refuse before scene mutation.
    numbers(frame.drawOrder, 'drawOrder'); numbers(frame.vertices, 'vertices'); numbers(frame.tint, 'tint');
    if (!Number.isInteger(frame.count) || frame.count < 0 || frame.count > frame.drawOrder.length) {
      throw new Error(`PixiRenderer: live frame count=${frame.count} needs an integer in 0..${frame.drawOrder.length}`);
    }
    for (let i = 0; i < frame.count; i++) {
      const index = frame.drawOrder[i];
      const attachment = frame.attachments[index];
      if (!Number.isInteger(index) || !attachment || (attachment.kind !== 'region' && attachment.kind !== 'mesh')) {
        throw new Error(`PixiRenderer: live drawOrder[${i}]=${index} needs a region or mesh attachment`);
      }
      const a = attachment;
      if (typeof a.slot !== 'string' || a.slot.length === 0 || typeof a.page !== 'string' || a.page.length === 0 ||
          (a.kind === 'region' && (typeof a.region !== 'string' || a.region.length === 0))) {
        throw new Error(`PixiRenderer: live slot "${a.slot}" needs named slot, page and region metadata`);
      }
      numbers(a.uvs, `slot "${a.slot}" uvs`); numbers(a.triangles, `slot "${a.slot}" triangles`);
      if (a.dark !== null) numbers(a.dark, `slot "${a.slot}" dark`);
      if (a.clip !== null) numbers(a.clip.polygon, `slot "${a.slot}" clip.polygon`);
      if (!Number.isInteger(a.offset) || !Number.isInteger(a.count) || a.offset < 0 || a.count < 0 || a.offset + a.count > frame.vertices.length ||
          !Number.isInteger(a.slotIndex) || a.slotIndex < 0 || a.slotIndex * 4 + 4 > frame.tint.length) {
        throw new Error(`PixiRenderer: live slot "${a.slot}" has invalid vertex span ${a.offset}+${a.count} or tint slotIndex=${a.slotIndex}`);
      }
      let row = this.rows[i];
      if (!row || row.slot.kind !== a.kind || row.points.count !== a.count) {
        const points = new NumberSpan(a.count);
        const tint = new NumberSpan(4);
        const common = { slot: a.slot, blend: a.blend, tint, page: a.page ?? '', pma: a.pma, uvs: EMPTY };
        const slot: DrawSlot = a.kind === 'region'
          ? { ...common, kind: 'region', region: a.region ?? '', corners: points }
          : { ...common, kind: 'mesh', vertices: points, triangles: EMPTY };
        row = { slot, points, tint };
        this.rows[i] = row;
      }
      row.points.source = frame.vertices; row.points.offset = a.offset;
      row.tint.source = frame.tint; row.tint.offset = a.slotIndex * 4;
      const slot = row.slot;
      slot.slot = a.slot; slot.blend = a.blend; slot.page = a.page ?? ''; slot.pma = a.pma;
      slot.uvs = a.uvs; slot.dark = a.dark ?? undefined; slot.clip = a.clip ?? undefined;
      if (slot.kind === 'region') slot.region = a.region ?? '';
      else slot.triangles = a.triangles;
      this.order[i] = slot;
    }
    this.order.length = frame.count;
    return this.order;
  }

  release(): void {
    for (const row of this.rows) {
      row.points.source = EMPTY; row.tint.source = EMPTY;
      row.slot.uvs = EMPTY; row.slot.dark = undefined; row.slot.clip = undefined;
      if (row.slot.kind === 'mesh') row.slot.triangles = EMPTY;
    }
  }
}

function identity(a: LiveAttachment): string {
  return JSON.stringify([a.slotIndex, a.slot, a.skin, a.placeholder, a.attachment, a.kind, a.page, a.region]);
}

interface SavedRow { template: PosedSlot; vertices: Float64Array; tint: Float64Array }

/** Exact last-drawn values, independent of later direct RigPlayer mutations. */
export class RetainedRuntimeFrame {
  private readonly templates = new WeakMap<LiveAttachment, PosedSlot>();
  private readonly checkedTemplates = new Map<string, PosedSlot>();
  private readonly rows: SavedRow[] = [];
  private count = 0;
  private generation = 0;
  private retained: PosedFrame | null = null;

  capture(frame: LiveFrame, seed: () => PosedFrame): void {
    let snapshot: PosedFrame | null = null;
    for (let i = 0; i < frame.count; i++) {
      const a = frame.attachments[frame.drawOrder[i]];
      let template = this.templates.get(a);
      if (!template) {
        // Production metadata is stable: the WeakMap hit above allocates no
        // keys. Checked leases wrap metadata anew, so use a bounded slow path.
        const key = identity(a);
        template = this.checkedTemplates.get(key);
        if (!template) {
          snapshot ??= seed();
          template = snapshot.order[i];
          if (!template || template.slot !== a.slot || template.kind !== a.kind || template.page !== a.page) {
            throw new Error(`PixiRig: live slot "${a.slot}" needs a matching snapshot metadata seed at draw index ${i}`);
          }
          // z and sequence come only from a real snapshot, never guessed from a lease.
          if (this.checkedTemplates.size >= Math.max(64, frame.attachments.length * 2)) this.checkedTemplates.clear();
          this.checkedTemplates.set(key, template);
        }
        this.templates.set(a, template);
      }
      let row = this.rows[i];
      if (!row || row.vertices.length !== a.count) {
        row = { template, vertices: new Float64Array(a.count), tint: new Float64Array(4) };
        this.rows[i] = row;
      }
      row.template = template;
      for (let j = 0; j < a.count; j++) row.vertices[j] = frame.vertices[a.offset + j];
      for (let j = 0; j < 4; j++) row.tint[j] = frame.tint[a.slotIndex * 4 + j];
    }
    this.count = frame.count;
    this.generation = frame.generation;
    this.retained = null;
  }

  snapshot(): PosedFrame {
    if (this.retained) return this.retained;
    const order: PosedSlot[] = [];
    for (let i = 0; i < this.count; i++) {
      const { template, vertices, tint } = this.rows[i];
      const common = { ...template, tint: [tint[0], tint[1], tint[2], tint[3]] as [number, number, number, number] };
      order.push(template.kind === 'region'
        ? { ...common, kind: 'region', region: template.region, corners: Array.from(vertices) }
        : { ...common, kind: 'mesh', vertices: Array.from(vertices), triangles: template.triangles, sequence: template.sequence });
    }
    this.retained = { order };
    Object.defineProperty(this.retained, 'generation', { value: this.generation, enumerable: false, configurable: true });
    return this.retained;
  }

  /** Explicit draw() already requested a detached snapshot. */
  retain(frame: PosedFrame): void { this.retained = frame; }
}
