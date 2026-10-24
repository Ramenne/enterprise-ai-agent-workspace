export type PendingMutation = {
  id: string;
  computer: string;
  thread: string;
  message?: string;
  provider?: string;
  operation?: string;
};
const key = (account: string) => "employeeclient:collaboration:pending:" + account;
export function savePending(account: string, value: PendingMutation | null) {
  if (!account) throw new Error("账号未确认，未发送");
  if (value)
    localStorage.setItem(
      key(account),
      JSON.stringify({
        id: value.id,
        computer: value.computer,
        thread: value.thread,
        provider: value.provider || "codex",
        operation:value.operation,
      }),
    );
  else localStorage.removeItem(key(account));
}
export function loadPending(account: string): PendingMutation | null {
  const raw = localStorage.getItem(key(account));
  if (!raw) return null;
  const value = JSON.parse(raw);
  if (
    !value ||
    !["id", "computer", "thread"].every(
      (k) =>
        typeof value[k] === "string" &&
        value[k].length > 0 &&
        value[k].length < 200,
    )
  )
    throw new Error("原操作记录无法读取，请先在 Mac 核对任务，暂不发送新指令");
  return value;
}

export function clearPending(account:string,id:string){
  // A late callback from an older login must not clear a newer intention.
  if(loadPending(account)?.id===id)localStorage.removeItem(key(account));
}
