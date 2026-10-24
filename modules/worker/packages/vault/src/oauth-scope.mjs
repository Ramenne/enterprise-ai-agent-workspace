/** Root must add hufu.vault.read to the actual member bridge/parent ceiling. No permission grant here. */
export function ordinaryVaultReadActions(scopes,currentParentActions){if(!Array.isArray(scopes)||!Array.isArray(currentParentActions))throw Error('server_derived_parent_required');return scopes.includes('hub2.read')&&currentParentActions.includes('hufu.vault.read')?['hufu.vault.read']:[];}
// Never reinterpret mem.read or resource.read as Vault read; do not mint or widen existing tokens.
