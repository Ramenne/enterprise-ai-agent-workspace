// A read-only fallback for commands whose old gateway receipt is permanently
// uncertain. Only an exact native message ID proves that a write landed.
export async function findNativeMessageReceipt(
  commandId: string,
  readPage: (cursor?: string) => Promise<{turns?: {messages?: {role?: string;client_id?: string}[]}[];cursor?: string|null}>,
): Promise<boolean> {
  let cursor: string | undefined;
  const visited = new Set<string>();
  for (let page = 0; page < 64; page++) {
    const result = await readPage(cursor);
    if (result.turns?.some(turn => turn.messages?.some(message => message.role === 'user' && message.client_id === commandId))) return true;
    if (!result.cursor || visited.has(result.cursor)) return false;
    visited.add(result.cursor);
    cursor = result.cursor;
  }
  return false;
}
