// src/store/ui.ts —— 【职责1 页面与组件】共享 UI 状态：toast、覆盖层、确认对话框。
// 覆盖层用集中状态而非每页各写一套，保证创建/通知/确认等交互在任意页面一致复用。
import { defineStore } from 'pinia';
import { ref } from 'vue';
import {userError,isRetryableFailure} from '../domain/userError.mjs';

export interface Toast { id: number; msg: string; error: boolean; attention: boolean; recoverable?:boolean }
export interface ConfirmOptions { title: string; text?: string; label?: string; cancelLabel?: string; danger?: boolean }
/**
 * 覆盖层种类。每个值都必须在 OverlayHost.vue 里有一个真实组件对应，不允许只声明不渲染的空枚举。
 *
 * 已删除的两个值（不要恢复）：
 *  - 'notifications'：原型把消息做成弹层，本客户端用路由页 /notifications（NotificationsView），
 *    因为通知点击深链、系统返回键与分享链接都需要可直达的地址；保留弹层枚举只会成为死分支。
 *  - 'deviceDelivery'：原型的 deliveryModal 是自述“演示投递状态，不是真实系统回执”的模拟屏（带“演示重试”按钮），
 *    主线服务端没有按通知查设备投递回执的账号接口；而策划 v0.24 §零-10 明确禁止把本地展示伪记为供应商 sent，
 *    因此不做这个屏，也不留空枚举。真实设备绑定状态在“通知与连接”弹层里按 me.devices() 如实展示。
 */
export type OverlayKind =
  | 'create' | 'taskMore' | 'projectForm' | 'projectMore' | 'review' | 'claim' | 'supplement' | 'urge'
  | 'announcementForm' | 'announcement' | 'archiveIssue' | 'copyFallback'
  | 'notificationSettings' | 'about' | 'search'
  | null;

let toastSeq = 0;
let confirmResolver: ((v: boolean) => void) | null = null;

export const useUiStore = defineStore('ui', () => {
  let feedbackEpoch=0;
  const toasts = ref<Toast[]>([]);
  const overlay = ref<OverlayKind>(null);
  const overlayProps = ref<Record<string, unknown>>({});
  // 确认框独立于内容覆盖层：可叠在 create/review 等之上（公司公开确认、危险操作确认）。
  const confirmVisible = ref(false);
  const confirmOptions = ref<ConfirmOptions | null>(null);

  function toast(msg: string, severity: boolean | 'action' = false, recoverable=false): void {
    if(!msg.trim())return;
    const error = severity === true;
    const attention = severity === 'action';
    if(toasts.value.some(t=>t.msg===msg&&t.error===error&&t.attention===attention))return;
    const id = ++toastSeq;
    toasts.value.push({ id, msg, error, attention, recoverable });
    if(toasts.value.length>2)toasts.value.splice(0,toasts.value.length-2);
    // Ongoing failures belong beside the affected operation, not in a stale toast.
    setTimeout(() => { toasts.value = toasts.value.filter(t => t.id !== id); }, attention ? 5000 : 2400);
  }
  function reportError(error:unknown,fallback='操作暂未完成，请重试'){toast(userError(error,fallback),true,isRetryableFailure(error));}
  function clearErrors(recoverableOnly=false){if(!recoverableOnly)feedbackEpoch++;toasts.value=toasts.value.filter(t=>!t.error||recoverableOnly&&!t.recoverable);}
  function captureFeedback(){const epoch=feedbackEpoch;return {reportError:(error:unknown,fallback?:string)=>{if(epoch===feedbackEpoch)reportError(error,fallback);},toast:(msg:string,severity:boolean|'action'=false)=>{if(epoch===feedbackEpoch)toast(msg,severity);}};}
  function openOverlay(kind: Exclude<OverlayKind, null>, props: Record<string, unknown> = {}): void {
    overlay.value = kind; overlayProps.value = props;
  }
  function closeOverlay(): void { overlay.value = null; overlayProps.value = {}; }
  /** 承诺式确认：解决 true/false；独立渲染，不影响下层内容覆盖层。 */
  function confirm(opts: ConfirmOptions): Promise<boolean> {
    if (confirmResolver) { confirmResolver(false); confirmResolver = null; }
    confirmOptions.value = opts; confirmVisible.value = true;
    return new Promise<boolean>((resolve) => { confirmResolver = resolve; });
  }
  function resolveConfirm(v: boolean): void {
    const r = confirmResolver; confirmResolver = null; confirmOptions.value = null; confirmVisible.value = false;
    if (r) r(v);
  }

  return { toasts, overlay, overlayProps, confirmVisible, confirmOptions, toast, reportError, clearErrors, captureFeedback, openOverlay, closeOverlay, confirm, resolveConfirm };
});
