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

  test('frozen metadata uses object identity; checked wrappers reuse a bounded metadata seed', () => {
    const { frame, snapshot } = fixture();
    let identityReads = 0;
    const metadata = new Proxy(Object.freeze(frame.attachments[0]), { get(target, property) {
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
  test('mutable identity is rechecked instead of reusing a stale template', () => {
    const { frame, snapshot } = fixture();
    const saved = new RetainedRuntimeFrame();
    saved.capture(frame, () => snapshot);
    frame.attachments[0].slot = 'replacement';
    expect(() => saved.capture(frame, () => snapshot)).toThrow('matching snapshot metadata seed');
    const replacement = { order: [{ ...snapshot.order[0], slot: 'replacement' }] };
    saved.capture(frame, () => replacement);
    expect(saved.snapshot().order[0].slot).toBe('replacement');
  });

  test('dark and clip values are reread and detached even with frozen attachment identity', () => {
    const { frame, snapshot } = fixture();
    const dark = [.1, .2, .3], polygon = [0, 0, 1, 0, 1, 1];
    const clip = { polygon, inverse: false, convex: true };
    frame.attachments = [Object.freeze({ ...frame.attachments[0], dark, clip })];
    const views = new LiveDrawViews(), saved = new RetainedRuntimeFrame();
    expect(views.read(frame)[0].dark[0]).toBe(.1); views.release();
    saved.capture(frame, () => snapshot);
    const previous = saved.snapshot();
    dark[0] = .9; polygon[0] = 10; clip.inverse = true;
    expect(views.read(frame)[0].dark[0]).toBe(.9);
    expect(views.read(frame)[0].clip.inverse).toBe(true); views.release();
    saved.capture(frame, () => { throw Error('unexpected seed'); });
    expect(saved.snapshot().order[0].dark[0]).toBe(.9);
    expect(saved.snapshot().order[0].clip.polygon[0]).toBe(10);
    expect(saved.snapshot().order[0].clip.inverse).toBe(true);
    expect(previous.order[0].dark[0]).toBe(.1);
    expect(previous.order[0].clip.polygon[0]).toBe(0);
    expect(previous.order[0].clip.inverse).toBe(false);
    clip.polygon = { length: -1 };
    expect(() => views.read(frame)).toThrow('clip.polygon');
  });

  test('mutable draw metadata is revalidated per frame and checked buffers stay indexed', () => {
    const { frame, snapshot } = fixture();
    const views = new LiveDrawViews();
    views.read(frame); views.release();
    frame.attachments[0].page = '';
    expect(() => views.read(frame)).toThrow('named slot, page and region metadata');
    frame.attachments[0].page = 'atlas';
    frame.attachments[0].dark = { length: -1 };
    expect(() => views.read(frame)).toThrow('dark');
    frame.attachments[0].dark = null;
    const indexed = value => new Proxy({}, {get(_target,key) {
      if (key === 'subarray' || key === 'buffer' || key === Symbol.iterator) throw Error('CHECKED_ESCAPE');
      return Reflect.get(value,key,value);
    }});
    frame.vertices = indexed(frame.vertices); frame.tint = indexed(frame.tint);
    const saved = new RetainedRuntimeFrame(); saved.capture(frame, () => snapshot);
    expect(saved.snapshot().order[0].vertices).toEqual(snapshot.order[0].vertices);
  });

});

test('retained whole buffers respect changed draw offsets, order, length and old snapshots', () => {
 const {frame,snapshot}=fixture();
 const saved=new RetainedRuntimeFrame();
 saved.capture(frame,()=>snapshot);const old=saved.snapshot();
 frame.vertices=new Float64Array([90,91,10,20,30,40,50,60]);
 frame.tint=new Float64Array([9,9,9,9,.9,.8,.7,.6]);
 frame.attachments=[{...frame.attachments[0],offset:2,slotIndex:1}];
 saved.capture(frame,()=>snapshot);
 expect(saved.snapshot().order[0].vertices).toEqual([10,20,30,40,50,60]);
 expect(saved.snapshot().order[0].tint).toEqual([.9,.8,.7,.6]);
 expect(old.order[0].vertices).toEqual([1,2,3,4,5,6]);
 frame.vertices=new Float64Array([2,4,6,8,10,12]);frame.attachments[0].offset=0;
 saved.capture(frame,()=>snapshot);
 expect(saved.snapshot().order[0].vertices).toEqual([2,4,6,8,10,12]);
 frame.count=0;saved.capture(frame,()=>snapshot);expect(saved.snapshot().order).toEqual([]);
});
test('native retained capture does not allocate per-row subarray views', () => {
 const {frame,snapshot}=fixture();const saved=new RetainedRuntimeFrame();
 const original=Float64Array.prototype.subarray;
 Float64Array.prototype.subarray=function(){throw Error('PER_ROW_VIEW_ALLOCATION');};
 try{
  saved.capture(frame,()=>snapshot);frame.vertices[0]=9;saved.capture(frame,()=>snapshot);
  expect(saved.snapshot().order[0].vertices[0]).toBe(9);
 }finally{Float64Array.prototype.subarray=original;}
});
test('frozen inherited and accessor identity remains mutable and must be revalidated', () => {
 for(const mode of ['inherited','accessor']){
  const {frame,snapshot}=fixture();const original=frame.attachments[0];
  let slot='mesh';const parent={slot};let a;
  if(mode==='inherited'){a=Object.assign(Object.create(parent),original);delete a.slot;}
  else{a={...original};Object.defineProperty(a,'slot',{get:()=>slot,enumerable:true});}
  Object.freeze(a);frame.attachments=[a];const saved=new RetainedRuntimeFrame(),views=new LiveDrawViews();
  views.read(frame);views.release();saved.capture(frame,()=>snapshot);
  if(mode==='inherited')parent.slot='replacement';else slot='replacement';
  expect(()=>saved.capture(frame,()=>snapshot)).toThrow('matching snapshot metadata seed');
  if(mode==='inherited')parent.slot='';else slot='';
  expect(()=>views.read(frame)).toThrow('named slot, page and region metadata');
 }
});
test('frozen valid metadata never caches current vertex and tint bounds', () => {
 const {frame}=fixture();frame.attachments=[Object.freeze(frame.attachments[0])];const views=new LiveDrawViews();
 views.read(frame);views.release();frame.vertices=new Float64Array(2);
 expect(()=>views.read(frame)).toThrow('invalid vertex span');
 frame.vertices=new Float64Array(6);frame.tint=new Float64Array(2);
 expect(()=>views.read(frame)).toThrow('tint slotIndex');
});

test('retained dark/clip storage is reused across captures, resizing and absent rows', () => {
  const { frame, snapshot } = fixture();
  const a = frame.attachments[0];
  a.dark = [.1, .2, .3]; a.clip = { polygon: [0, 0, 1, 0, 1, 1], inverse: false, convex: true };
  const saved = new RetainedRuntimeFrame();
  saved.capture(frame, () => snapshot);
  const row = saved.rows[0], dark = row.dark, clip = row.clip, polygon = clip.polygon;
  const old = saved.snapshot();
  old.order[0].dark[0] = .7; old.order[0].clip.polygon[0] = 77;
  expect(dark[0]).toBe(.1); expect(polygon[0]).toBe(0);
  a.dark[0] = .9; a.clip.polygon = [4, 0, 2, 0, 2, 2, 0, 2]; a.clip.inverse = true;
  saved.capture(frame, () => snapshot);
  expect(row.dark).toBe(dark); expect(row.clip).toBe(clip); expect(row.clip.polygon).toBe(polygon);
  expect(saved.snapshot().order[0].dark).toEqual([.9, .2, .3]);
  expect(saved.snapshot().order[0].clip.polygon).toEqual(a.clip.polygon);
  expect(saved.snapshot().order[0].clip.inverse).toBe(true);
  expect(old.order[0].dark[0]).toBe(.7); expect(old.order[0].clip.polygon[0]).toBe(77);
  a.dark = null; a.clip = null; saved.capture(frame, () => snapshot);
  expect(saved.snapshot().order[0].dark).toBeUndefined(); expect(saved.snapshot().order[0].clip).toBeUndefined();
  a.dark = [.3, .4, .5]; a.clip = { polygon: [1, 1, 2, 1, 2, 2], inverse: false, convex: true };
  saved.capture(frame, () => snapshot);
  expect(row.dark).toBe(dark); expect(row.clip).toBe(clip); expect(row.clip.polygon).toBe(polygon);
  expect(saved.snapshot().order[0].clip.polygon).toEqual([1, 1, 2, 1, 2, 2]);
  // Fresh-copy mutant is rejected by the same storage identity assertion.
  const fresh = Array.from(row.dark);
  expect(fresh === dark).toBe(false);
});
