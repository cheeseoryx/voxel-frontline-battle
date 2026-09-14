import {describe,expect,it} from 'vitest';
import {isLiveDevInputChange} from '../live-dev-watch.js';
describe('live development source invalidation',()=>{
 it.each([null,undefined,''])('ignores an unattributed filesystem event: %s',filename=>expect(isLiveDevInputChange(filename)).toBe(false));
 it.each(['artifacts-capture.log','dev/trace.LOG','.forgeax/dev-session.json','node_modules/.vite/cache.json','artifacts/capture.png','dist/index.html','coverage/index.html','.forgeax\\generated\\host.ts'])('ignores generated output: %s',filename=>expect(isLiveDevInputChange(filename)).toBe(false));
 it.each(['forge.json','assets/plugin.ts','assets/ui/frontline.ui.css'])('retains author source invalidation: %s',filename=>expect(isLiveDevInputChange(filename)).toBe(true));
});
