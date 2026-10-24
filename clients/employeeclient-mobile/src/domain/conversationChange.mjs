// A read/pin/snooze receipt changes inbox state, not the conversation body.
export function conversationContentChanged(previous,next){
 return !previous||previous.kind!==next.kind||previous.object_id!==next.object_id||previous.title!==next.title||previous.summary!==next.summary||previous.snapshot?.message_change!==next.snapshot?.message_change;
}
