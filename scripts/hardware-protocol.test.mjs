import { expect, test } from 'bun:test';
import { captureProtocols, assertCaptureProtocol, FRAME_PROTOCOL, CAPTURE_PROTOCOL, DECISION_PROTOCOL, LEGACY_CAPTURE_PROTOCOL } from './hardware-protocol.mjs';

test('prepared capture declares separate pairing, schedule and decision versions', () => {
  expect(captureProtocols()).toEqual({ protocol: FRAME_PROTOCOL, captureProtocol: CAPTURE_PROTOCOL, decisionProtocol: DECISION_PROTOCOL });
  for (const pairs of [3, 6]) expect(assertCaptureProtocol(captureProtocols(), pairs)).toBe(CAPTURE_PROTOCOL);
});

test('old two-pair reader control is explicitly distinguished', () => {
  expect(assertCaptureProtocol({ protocol: FRAME_PROTOCOL }, 2)).toBe(LEGACY_CAPTURE_PROTOCOL);
  expect(() => assertCaptureProtocol(captureProtocols(), 2)).toThrow('HARDWARE_SUMMARY_PROTOCOL');
});

for (const key of ['protocol', 'captureProtocol', 'decisionProtocol']) test(`missing or different ${key} refuses new capture`, () => {
  for (const value of [undefined, 'different']) {
    const manifest = { ...captureProtocols(), [key]: value };
    expect(() => assertCaptureProtocol(manifest, 3)).toThrow('HARDWARE_SUMMARY_PROTOCOL');
  }
});
