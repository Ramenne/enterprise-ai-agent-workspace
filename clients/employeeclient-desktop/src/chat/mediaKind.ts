import {isVoiceMessage as classifyVoice} from '../../shared/chat-media-purpose.mjs';
export {isGroupFile} from '../../shared/chat-media-purpose.mjs';
export type ChatMediaPurpose = 'voice' | 'file';
export function isVoiceMessage(a: { purpose?: ChatMediaPurpose; name: string; mime: string }): boolean { return classifyVoice(a); }
export function voiceBubbleWidth(seconds: number): number {
  // Short clips need a usable target; long clips grow more slowly. The CSS
  // container still caps this logical width on narrow screens.
  const duration = Math.min(60, Math.max(0, Number.isFinite(seconds) ? seconds : 0));
  return 104 + Math.min(duration, 10) * 4 + Math.max(0, duration - 10) * 1.6;
}
