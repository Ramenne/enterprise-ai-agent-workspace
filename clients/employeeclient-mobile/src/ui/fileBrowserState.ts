// Only navigation state is retained, never file URLs or another account's data.
export interface FileBrowserState { scope: 'chat' | 'company' | 'personal'; selected: string; project?: string; search: string; scroll: number; pages?: number }
let owner = '', state: FileBrowserState | undefined;
export function readFileBrowserState(account: string): FileBrowserState | undefined {
  if (owner !== account) { owner = account; state = undefined; }
  return state && { ...state };
}
export function saveFileBrowserState(account: string, value: FileBrowserState) {
  owner = account; state = { ...value };
}
