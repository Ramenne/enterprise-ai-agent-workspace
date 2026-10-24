import { readFileSync } from 'node:fs';
export const designCss = ['base','readability','app'].map(name => `@layer legacy {${readFileSync(`src/ui/styles/${name}.css`, 'utf8')}}`).join('\n') + ['tokens','ui-v2','workspace'].map(name => readFileSync(`src/ui/styles/${name}.css`, 'utf8')).join('\n');
