import type {McpServer} from '@modelcontextprotocol/server';
import type {VaultService} from './service.mjs';
import type {z} from 'zod';
export function httpVaultClient(config:{hufuURL:string}):VaultService;
export function registerVaultTools(mcp:McpServer,config:{inputSchemas:Record<string,z.ZodObject>;service:VaultService;legacyAliases?:boolean}):void;
