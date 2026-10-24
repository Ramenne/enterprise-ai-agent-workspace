import { collaboration, type Command } from "./api";
export class UnconfirmedCommand extends Error {
  constructor(public id: string, message = "结果尚未确认，请先核对原任务；不会自动重复发送。", public result?: Record<string, any>) {
    super(message);
  }
}
export function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("已取消", "AbortError"));
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("已取消", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
export async function waitCommand(
  id: string,
  signal: AbortSignal,
): Promise<Record<string, any>> {
  const deadline = Date.now() + 55000;
  let after: string | undefined;
  while (Date.now() < deadline) {
    let c: Command;
    try {
      c = await collaboration.command(id, signal, after);
    } catch (e) {
      if (signal.aborted) throw e;
      await delay(1500, signal);
      continue;
    }
    if (c.state === "done") {
      const r = c.result as Record<string, any>;
      if (!r?.ok) {
        if (r?.uncertain) throw new UnconfirmedCommand(id, r.error || undefined, r);
        throw new Error(r?.error || "操作未完成");
      }
      return r;
    }
    if (c.state === "expired" || c.state === "cancelled")
      throw new Error("指令已过期或设备已解绑，没有执行。");
    if (c.state === "unconfirmed") throw new UnconfirmedCommand(id);
    if (c.state === "purged")
      throw new UnconfirmedCommand(id, "回执已过期，不能判断是否执行。请在 Mac 核对原任务后解除限制。");
    after=c.state;
    // A saturated or older gateway may return immediately: avoid a tight loop.
    if(c.wait_deferred||!c.wait_supported)await delay(700,signal);
  }
  throw new UnconfirmedCommand(id);
}
export async function runCommand(
  computer: string,
  request: Record<string, unknown>,
  signal: AbortSignal,
  id: string = crypto.randomUUID(),
) {
  try {
    await collaboration.submit(
      computer,
      id,
      { provider: "codex", ...request },
      signal,
    );
  } catch (e) {
    if (signal.aborted) throw e;
    if (
      e &&
      typeof e === "object" &&
      "status" in e &&
      Number(e.status) >= 400 &&
      Number(e.status) < 500
    )
      throw e;
  }
  // Lost submission ACK: read the same id, never send a second mutation.
  return waitCommand(id, signal);
}
