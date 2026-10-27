import type { LiveAttachment, LiveFrame, LiveNumbers, PosedClip, PosedFrame, PosedMesh, PosedRegion, PosedSlot } from '@rig-c/play';

export type DrawClip = Omit<PosedClip, 'polygon'> & { polygon: LiveNumbers };
type Common = { tint: DrawNumbers; dark?: LiveNumbers; clip?: DrawClip };
export type DrawRegion = Omit<PosedRegion, 'z' | 'corners' | 'uvs' | 'tint' | 'dark' | 'clip'> & Common & { corners: DrawNumbers; uvs: LiveNumbers };
export type DrawMesh = Omit<PosedMesh, 'z' | 'vertices' | 'uvs' | 'triangles' | 'tint' | 'dark' | 'clip' | 'sequence'> & Common & {
  vertices: DrawNumbers; uvs: LiveNumbers; triangles: LiveNumbers; sequence?: number;
};
export type DrawSlot = DrawRegion | DrawMesh;
const EMPTY: LiveNumbers = Object.freeze([]);
const immutableLengths = new WeakSet<object>();
const immutableMetadata = new WeakSet<LiveAttachment>();
const IDENTITY_FIELDS = ['slot', 'slotIndex', 'attachment', 'skin', 'placeholder', 'kind', 'region', 'page', 'pma', 'blend', 'offset', 'count'];

/** Frozen own primitive fields cannot change through a prototype or getter. */
function frozenData(value: LiveAttachment): boolean {
  if (immutableMetadata.has(value)) return true;
  if (!Object.isFrozen(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (!IDENTITY_FIELDS.every(key => {
    const descriptor = descriptors[key];
    return descriptor && 'value' in descriptor &&
      (descriptor.value === null || !['object', 'function'].includes(typeof descriptor.value));
  })) return false;
  immutableMetadata.add(value);
  return true;
}

function numbers(value: LiveNumbers, field: string, slot?: string): void {
  if (value && typeof value === 'object' && immutableLengths.has(value)) return;
  if (!value || typeof value !== 'object' || !Number.isInteger(value.length) || value.length < 0) {
    throw new Error(`PixiRenderer: live ${slot === undefined ? field : `slot "${slot}" ${field}`} needs an indexed buffer with nonnegative integer length`);
  }
  // Only the length invariant is cached. Numeric contents are still validated
  // by the renderer, and a replaced dark/clip buffer takes this check anew.
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (length && 'value' in length && !length.writable && !length.configurable && Object.isFrozen(value)) immutableLengths.add(value);
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
  private readonly validated = new WeakSet<LiveAttachment>();

  read(frame: LiveFrame): readonly DrawSlot[] {
    void frame.generation; // Checked stale leases refuse before scene mutation.
    const { drawOrder, vertices, tint, attachments, count } = frame;
    numbers(drawOrder, 'drawOrder'); numbers(vertices, 'vertices'); numbers(tint, 'tint');
    if (!Number.isInteger(count) || count < 0 || count > drawOrder.length) {
      throw new Error(`PixiRenderer: live frame count=${count} needs an integer in 0..${drawOrder.length}`);
    }
    for (let i = 0; i < count; i++) {
      const index = drawOrder[i];
      const attachment = attachments[index];
      if (!Number.isInteger(index) || !attachment || (attachment.kind !== 'region' && attachment.kind !== 'mesh')) {
        throw new Error(`PixiRenderer: live drawOrder[${i}]=${index} needs a region or mesh attachment`);
      }
      const a = attachment;
      if (!this.validated.has(a)) {
        if (typeof a.slot !== 'string' || a.slot.length === 0 || typeof a.page !== 'string' || a.page.length === 0 ||
            (a.kind === 'region' && (typeof a.region !== 'string' || a.region.length === 0))) {
          throw new Error(`PixiRenderer: live slot "${a.slot}" needs named slot, page and region metadata`);
        }
        if (!Number.isInteger(a.offset) || !Number.isInteger(a.count) || a.offset < 0 || a.count < 0 ||
            !Number.isInteger(a.slotIndex) || a.slotIndex < 0) {
          throw new Error(`PixiRenderer: live slot "${a.slot}" has invalid vertex span ${a.offset}+${a.count} or tint slotIndex=${a.slotIndex}`);
        }
        if (frozenData(a)) this.validated.add(a);
      }
      numbers(a.uvs, 'uvs', a.slot); numbers(a.triangles, 'triangles', a.slot);
      if (a.dark !== null) numbers(a.dark, 'dark', a.slot);
      if (a.clip !== null) numbers(a.clip.polygon, 'clip.polygon', a.slot);
      if (a.offset + a.count > vertices.length || a.slotIndex * 4 + 4 > tint.length) {
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
      row.points.source = vertices; row.points.offset = a.offset;
      row.tint.source = tint; row.tint.offset = a.slotIndex * 4;
      const slot = row.slot;
      slot.slot = a.slot; slot.blend = a.blend; slot.page = a.page ?? ''; slot.pma = a.pma;
      slot.uvs = a.uvs; slot.dark = a.dark ?? undefined; slot.clip = a.clip ?? undefined;
      if (slot.kind === 'region') slot.region = a.region ?? '';
      else slot.triangles = a.triangles;
      this.order[i] = slot;
    }
    this.order.length = count;
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

interface SavedRow {
  template: PosedSlot; offset: number; count: number; tintOffset: number;
  dark?: number[]; clip?: PosedClip;
}

/** Only actual typed arrays take the native-copy path; checked proxies stay indexed. */
function copyNumbers(target: Float64Array, source: LiveNumbers): void {
  if (ArrayBuffer.isView(source) && source instanceof Float64Array) {
    target.set(source);
  } else {
    for (let i = 0; i < target.length; i++) target[i] = source[i];
  }
}

function savedNumbers(source: Float64Array, offset: number, count: number): number[] {
  const result = new Array<number>(count);
  for (let i = 0; i < count; i++) result[i] = source[offset + i];
  return result;
}

/** Exact last-drawn values, independent of later direct RigPlayer mutations. */
export class RetainedRuntimeFrame {
  private readonly templates = new WeakMap<LiveAttachment, PosedSlot>();
  private readonly immutable = new WeakSet<LiveAttachment>();
  private readonly checkedTemplates = new Map<string, PosedSlot>();
  private readonly rows: SavedRow[] = [];
  private vertices = new Float64Array(0);
  private tint = new Float64Array(0);
  private count = 0;
  private generation = 0;
  private retained: PosedFrame | null = null;

  capture(frame: LiveFrame, seed: () => PosedFrame): void {
    let snapshot: PosedFrame | null = null;
    const { count, attachments, drawOrder, vertices, tint } = frame;
    // One owned copy per buffer avoids transient views for every drawn row.
    // No borrowed lease reference survives capture, including checked buffers.
    if (this.vertices.length !== vertices.length) this.vertices = new Float64Array(vertices.length);
    if (this.tint.length !== tint.length) this.tint = new Float64Array(tint.length);
    copyNumbers(this.vertices, vertices);
    copyNumbers(this.tint, tint);
    for (let i = 0; i < count; i++) {
      const a = attachments[drawOrder[i]];
      let template = this.immutable.has(a) ? this.templates.get(a) : undefined;
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
        if (frozenData(a)) { this.immutable.add(a); this.templates.set(a, template); }
      }
      let row = this.rows[i];
      if (!row) {
        row = { template, offset: a.offset, count: a.count, tintOffset: a.slotIndex * 4 };
        this.rows[i] = row;
      }
      row.template = template;
      row.offset = a.offset; row.count = a.count; row.tintOffset = a.slotIndex * 4;
      // These can change independently of attachment identity. Detach at draw,
      // before a checked lease expires or the caller changes a nested buffer.
      row.dark = a.dark === null ? undefined : Array.from(a.dark);
      row.clip = a.clip === null ? undefined : {
        polygon: Array.from(a.clip.polygon), inverse: a.clip.inverse, convex: a.clip.convex,
      };
    }
    this.count = frame.count;
    this.generation = frame.generation;
    this.retained = null;
  }

  snapshot(): PosedFrame {
    if (this.retained) return this.retained;
    const order: PosedSlot[] = [];
    for (let i = 0; i < this.count; i++) {
      const { template, offset, count, tintOffset, dark, clip } = this.rows[i];
      const common = { ...template, tint: savedNumbers(this.tint, tintOffset, 4) as [number, number, number, number] };
      if (dark) common.dark = dark as [number, number, number]; else delete common.dark;
      if (clip) common.clip = clip; else delete common.clip;
      order.push(template.kind === 'region'
        ? { ...common, kind: 'region', region: template.region, corners: savedNumbers(this.vertices, offset, count) }
        : { ...common, kind: 'mesh', vertices: savedNumbers(this.vertices, offset, count), triangles: template.triangles, sequence: template.sequence });
    }
    this.retained = { order };
    Object.defineProperty(this.retained, 'generation', { value: this.generation, enumerable: false, configurable: true });
    return this.retained;
  }

  /** Explicit draw() already requested a detached snapshot. */
  retain(frame: PosedFrame): void { this.retained = frame; }
}
