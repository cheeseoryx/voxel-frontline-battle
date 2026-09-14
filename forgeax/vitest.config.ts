import {defineConfig} from 'vitest/config';
import {fileURLToPath} from 'node:url';
// Tests and editor types use the same local Engine selected by engine-binding.json.
const facade=fileURLToPath(new URL('../forgeax-engine/packages/engine/dist/facades/',import.meta.url));
export default defineConfig({resolve:{alias:[{find:/^@forgeax\/engine\/(.+)$/,replacement:facade+'$1.mjs'},{find:/^@forgeax\/engine$/,replacement:fileURLToPath(new URL('../forgeax-engine/packages/engine/dist/index.mjs',import.meta.url))}]},test:{name:'voxel-frontline/forgeax',environment:'node'}});
