/** Classify sealed CDP samples by call ancestry, independent of Vite chunk names. */
export function classifySubmitProfile(cpu) {
  const nodes = new Map(cpu.nodes.map(node => [node.id, node]));
  const parents = new Map();
  for (const node of cpu.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
  const key = frame => JSON.stringify([frame.scriptId, frame.lineNumber, frame.columnNumber]);
  const isAdapter = frame => frame?.url.includes('/packages/pixi/src/pixi.ts') && frame.functionName === 'render';
  const rigRoots = new Set();
  for (const node of cpu.nodes) {
    if (!isAdapter(node.callFrame)) continue;
    for (let id = parents.get(node.id); id !== undefined; id = parents.get(id)) {
      const frame = nodes.get(id).callFrame;
      if (/^drawAll\d*$/.test(frame.functionName) && frame.url.includes('/bench/main.ts')) {
        rigRoots.add(key(frame)); break;
      }
    }
  }
  if (!rigRoots.size) throw Error('PROFILE_ATTRIBUTION: no rig drawAll ancestry for adapter renderer');
  const groups = {};
  const leaves = {};
  for (let i = 0; i < (cpu.samples ?? []).length; i++) {
    const chain = [];
    for (let id = cpu.samples[i]; id !== undefined; id = parents.get(id)) chain.push(nodes.get(id).callFrame);
    let group = 'other (official arm, pose, GC, completion waits)';
    if (chain.some(isAdapter)) group = 'adapter render inclusive';
    else if (chain.some(frame => rigRoots.has(key(frame)))) {
      group = 'rig submit bookkeeping or unattributed';
      if (chain.some(frame => frame.functionName === 'render' && frame.url.includes('/node_modules/'))) {
        group = 'Pixi host other (packing, upload, driver)';
        if (chain.some(frame => /^(updateRenderGroupTransforms|updateTransformAndChildren|updateRenderGroupTransform|updateLocalTransform|validateRenderables|collectRenderables.*)$/.test(frame.functionName))) group = 'Pixi scene traversal, validation or transforms';
        else if (chain.some(frame => frame.functionName === '_updateRenderables')) group = 'Pixi renderable update (includes packing)';
      }
    }
    const duration = cpu.timeDeltas?.[i];
    if (!Number.isFinite(duration) || duration < 0) throw Error(`PROFILE_SAMPLE: invalid time delta at ${i}`);
    groups[group] = (groups[group] ?? 0) + duration;
    const leaf = `${group}: ${chain[0]?.functionName || '(anonymous)'}`;
    leaves[leaf] = (leaves[leaf] ?? 0) + duration;
  }
  return { sampledGroupMicroseconds: groups, sampledCpuMicroseconds: Object.entries(leaves).sort((a, b) => b[1] - a[1]) };
}
