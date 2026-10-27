/** Pairing implementation, launch schedule and decision rule have separate identities. */
export const FRAME_PROTOCOL = 'hardware-same-frame-v1';
export const CAPTURE_PROTOCOL = 'hardware-interleaved-ci-v2';
export const DECISION_PROTOCOL = 'hardware-launch-median-t95-v1';
export const LEGACY_CAPTURE_PROTOCOL = 'hardware-aa-before-ab-v1';

export function captureProtocols() {
  return { protocol: FRAME_PROTOCOL, captureProtocol: CAPTURE_PROTOCOL, decisionProtocol: DECISION_PROTOCOL };
}

export function assertCaptureProtocol(manifest, pairs) {
  const code = 'HARDWARE_SUMMARY_PROTOCOL';
  if (manifest?.protocol !== FRAME_PROTOCOL) throw Error(`${code}: pairing protocol found ${manifest?.protocol}; needed ${FRAME_PROTOCOL}`);
  if (pairs === 2) {
    if (manifest.captureProtocol !== undefined || manifest.decisionProtocol !== undefined) throw Error(`${code}: two-pair legacy control cannot claim the interleaved CI capture protocol`);
    return LEGACY_CAPTURE_PROTOCOL;
  }
  if (![3, 6].includes(pairs) || manifest.captureProtocol !== CAPTURE_PROTOCOL || manifest.decisionProtocol !== DECISION_PROTOCOL) {
    throw Error(`${code}: found ${manifest.captureProtocol}/${manifest.decisionProtocol}; needed ${CAPTURE_PROTOCOL}/${DECISION_PROTOCOL} with 3 or 6 pairs`);
  }
  return CAPTURE_PROTOCOL;
}
