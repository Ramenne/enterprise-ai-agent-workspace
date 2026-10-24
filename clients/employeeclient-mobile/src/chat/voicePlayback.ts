// One listening session, including a message whose signed URL is still loading.
// Releasing an old session must never stop the newer one.
let active: { key: symbol; stop: () => void } | undefined;
export function stopVoicePlayback() {
  const previous = active;
  active = undefined;
  previous?.stop();
}
export function claimVoice(stop: () => void) {
  const previous = active;
  const key = Symbol('voice');
  active = { key, stop };
  previous?.stop();
  return {
    current: () => active?.key === key,
    release: () => { if (active?.key === key) active = undefined; },
  };
}
