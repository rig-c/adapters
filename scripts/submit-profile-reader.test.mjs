import { expect, test } from 'bun:test';
import { classifySubmitProfile } from './submit-profile-reader.mjs';

function fixture() {
  const frame = (functionName, url, lineNumber) => ({ functionName, url, lineNumber, scriptId: '1', columnNumber: 0 });
  return {
    nodes: [
      { id: 1, callFrame: frame('root', '', 0), children: [2, 7] },
      { id: 2, callFrame: frame('drawAll', '/bench/main.ts', 10), children: [3, 4] },
      { id: 3, callFrame: frame('render', '/packages/pixi/src/pixi.ts', 20) },
      { id: 4, callFrame: frame('render', '/node_modules/.vite/deps/chunk-ABC.js', 30), children: [5, 6] },
      { id: 5, callFrame: frame('updateTransformAndChildren', '/node_modules/.vite/deps/chunk-XYZ.js', 40) },
      { id: 6, callFrame: frame('bufferSubData', '/node_modules/.vite/deps/chunk-XYZ.js', 50) },
      { id: 7, callFrame: frame('render', '/node_modules/.vite/deps/chunk-ABC.js', 30), children: [8] },
      { id: 8, callFrame: frame('updateTransformAndChildren', '/node_modules/.vite/deps/chunk-XYZ.js', 40) },
    ],
    samples: [3, 5, 6, 8], timeDeltas: [10, 20, 30, 40],
  };
}

test('opaque chunks retain stage attribution and exclude the official arm', () => {
  expect(classifySubmitProfile(fixture()).sampledGroupMicroseconds).toEqual({
    'adapter render inclusive': 10,
    'Pixi scene traversal, validation or transforms': 20,
    'Pixi host other (packing, upload, driver)': 30,
    'other (official arm, pose, GC, completion waits)': 40,
  });
});

test('missing adapter identity refuses instead of assigning all host work to rig', () => {
  const mutant = fixture();
  mutant.nodes[2].callFrame.url = '/unknown/producer.ts';
  expect(() => classifySubmitProfile(mutant)).toThrow('PROFILE_ATTRIBUTION');
});

test('negative or absent sampled duration refuses by name', () => {
  for (const value of [-1, undefined]) {
    const mutant = fixture();
    mutant.timeDeltas[0] = value;
    expect(() => classifySubmitProfile(mutant)).toThrow('PROFILE_SAMPLE');
  }
});
