import {searchInputContracts} from './search-contracts.mjs';
import {governanceInputContracts} from './governance-contracts.mjs';
import {vectorInputContracts} from './vector-contracts.mjs';
import {equivalenceInputContracts} from './equivalence-contracts.mjs';
import {externalInputContracts} from './external-model-contracts.mjs';
import {uploadInputContracts} from './upload-contracts.mjs';
import {effectInputContracts} from './effect-contracts.mjs';
import {legacyInputContracts} from './legacy-contracts.mjs';
import {coreInputContracts} from './core-contracts.mjs';
import {descriptionInputContracts} from './description-contracts.mjs';
import {agentInputContracts} from './agent-contracts.mjs';
import {processingInputContracts} from './processing-contracts.mjs';
import {navigationInputContracts} from './navigation-contracts.mjs';
// Publication index only; domain handlers import the same declarations above.
export const inputContracts=[...coreInputContracts.map(([path,schema])=>({path,schema,source:'source/apps/mem/src/core-contracts.mjs'})),...descriptionInputContracts.map(([path,schema])=>({path,schema,source:'source/apps/mem/src/description-contracts.mjs'})),...agentInputContracts.map(([path,schema])=>({path,schema,source:'source/apps/mem/src/agent-contracts.mjs'})),...processingInputContracts.map(([path,schema])=>({path,schema,source:'source/apps/mem/src/processing-contracts.mjs'})),...navigationInputContracts.map(([path,schema])=>({path,schema,source:'source/apps/mem/src/navigation-contracts.mjs'})),...legacyInputContracts.map(([path,schema])=>({path,schema,source:'source/apps/mem/src/legacy-contracts.mjs',projection:'legacy-domain-defaults-v1'})),...effectInputContracts.map(([path,schema])=>({path,schema,source:'source/apps/mem/src/effect-contracts.mjs'})),...uploadInputContracts.map(([path,schema])=>({path,schema,source:'source/apps/mem/src/upload-contracts.mjs'})),...externalInputContracts.map(([path,schema])=>({path,schema,source:'source/apps/mem/src/external-model-contracts.mjs'})),...equivalenceInputContracts.map(([path,schema])=>({path,schema,source:'source/apps/mem/src/equivalence-contracts.mjs'})),...vectorInputContracts.map(([path,schema])=>({path,schema,source:'source/apps/mem/src/vector-contracts.mjs'})),...governanceInputContracts.map(([path,schema])=>({path,schema,source:'source/apps/mem/src/governance-contracts.mjs'})),...searchInputContracts.map(([path,schema])=>({path,schema,source:'source/apps/mem/src/search-contracts.mjs'}))];
