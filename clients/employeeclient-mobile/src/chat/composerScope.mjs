// Only the active account and conversation may change transient composer UI.
export function sameComposerScope(scope,account,peer){return !!account&&scope?.account===account&&scope.peer===(peer||'');}
