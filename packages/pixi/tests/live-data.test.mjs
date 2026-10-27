import { describe, expect, test } from 'bun:test';
import { LiveDrawViews, RetainedRuntimeFrame, numberSource, numberOffset, numberCount } from '../src/live.ts';

function fixture() {
  const template = { slot: 'mesh', z: 37, blend: 'Additive', tint: [0.2, 0.4, 0.6, 0.8],
    kind: 'mesh', page: 'atlas', pma: true, vertices: [1, 2, 3, 4, 5, 6],
    uvs: [0, 0, 1, 0, 0, 1], triangles: [0, 1, 2], sequence: 17 };
  const frame = { generation: 9, count: 1, drawOrder: new Int32Array([0]),
    vertices: new Float64Array(template.vertices), tint: new Float64Array(template.tint),
    attachments: [{ slot: 'mesh', slotIndex: 0, attachment: 'drawing', skin: 'default', placeholder: 'key', kind: 'mesh',
      region: null, page: 'atlas', pma: true, blend: 'Additive', offset: 0, count: 6,
      uvs: new Float64Array(template.uvs), triangles: new Int32Array(template.triangles), dark: null, clip: null }] };
  return { frame, snapshot: { order: [template] } };
}

describe('live draw data controls', () => {
  test('exact retained metadata and numbers survive future source mutations', () => {
    const { frame, snapshot } = fixture();
    const saved = new RetainedRuntimeFrame();
    let seeds = 0;
    saved.capture(frame, () => { seeds++; return snapshot; });
    frame.vertices[0] = 999; frame.tint[0] = 0;
    expect(JSON.stringify(saved.snapshot())).toBe(JSON.stringify(snapshot));
    expect(saved.snapshot().generation).toBe(9);
    const retained = saved.snapshot();
    saved.capture(frame, () => { throw new Error('steady path requested a snapshot'); });
    expect(seeds).toBe(1);
    expect(retained.order[0].vertices[0]).toBe(1);
    expect(saved.snapshot().order[0].vertices[0]).toBe(999);
    expect(saved.snapshot().order[0].sequence).toBe(17);
    expect(saved.snapshot().order[0].z).toBe(37);
  });

  test('indexed spans read offset buffers directly without coordinate accessors or backing-store escape', () => {
    const { frame } = fixture();
    frame.vertices = new Float64Array([88, 88, 1, 2, 3, 4, 5, 6]);
    frame.attachments[0].offset = 2;
    frame.vertices = new Proxy(frame.vertices, { get(target, key) {
      if (key === Symbol.iterator || key === 'buffer' || key === 'slice' || key === 'subarray') throw new Error('ARRAY_ESCAPE');
      return Reflect.get(target, key, target);
    } });
    const views = new LiveDrawViews();
    const order = views.read(frame);
    const span = order[0].vertices;
    expect(numberSource(span)[numberOffset(span)]).toBe(1);
    expect(numberSource(span)[numberOffset(span) + 5]).toBe(6);
    expect(numberCount(span)).toBe(6);
    expect(Object.keys(span).sort()).toEqual(['count', 'offset', 'source']);
    expect(Object.getOwnPropertyDescriptor(span, '0')).toBeUndefined();
    expect('sequence' in order[0]).toBe(false);
    views.release();
    expect(numberSource(span)[numberOffset(span)]).toBeUndefined();
  });

  test('edge empty draw and wrong/missing metadata refuse by object name', () => {
    const { frame, snapshot } = fixture();
    const saved = new RetainedRuntimeFrame();
    expect(() => saved.capture(frame, () => ({ order: [] }))).toThrow('live slot "mesh"');
    frame.attachments[0].offset = 500;
    expect(() => new LiveDrawViews().read(frame)).toThrow('live slot "mesh"');
    frame.count = 0;
    saved.capture(frame, () => snapshot);
    expect(saved.snapshot().order).toEqual([]);
  });

  test('defect control: altered saved coordinates fails exact record equality', () => {
    const { frame, snapshot } = fixture();
    const saved = new RetainedRuntimeFrame();
    saved.capture(frame, () => snapshot);
    saved.snapshot().order[0].vertices[0] += 1;
    expect(JSON.stringify(saved.snapshot())).not.toBe(JSON.stringify(snapshot));
  });

  test('steady metadata lookup uses object identity; checked wrappers reuse a bounded metadata seed', () => {
    const { frame, snapshot } = fixture();
    let identityReads = 0;
    const metadata = new Proxy(frame.attachments[0], { get(target, property) {
      if (['skin', 'placeholder', 'attachment', 'region', 'page'].includes(property)) identityReads++;
      return Reflect.get(target, property);
    } });
    frame.attachments = [metadata];
    const saved = new RetainedRuntimeFrame();
    saved.capture(frame, () => snapshot);
    expect(identityReads).toBeGreaterThan(0);
    identityReads = 0;
    saved.capture(frame, () => { throw new Error('unexpected seed'); });
    expect(identityReads).toBe(0);
    for (let i = 0; i < 20; i++) {
      frame.attachments = [{ ...metadata }];
      saved.capture(frame, () => { throw new Error('checked wrapper requested another seed'); });
    }
    expect(saved.snapshot().order[0].sequence).toBe(17);
  });
});
