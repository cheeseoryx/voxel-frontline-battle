# @forgeax/engine-host

Engine's business-neutral frontend/backend host pair. Each host owns one
Cordis manager instance and native Loader lifecycle. The backend derives the
serializable frontend assembly; a browser fetches that projection, activates it,
and reports its actual Entry/Fiber result.

```ts
import { createBackendHost } from '@forgeax/engine-host/backend';
import { connectHostWebSocket } from '@forgeax/engine-host/transport';
import { createFrontendHost } from '@forgeax/engine-host/frontend';

const backend = await createBackendHost({ pairs, catalog });
const transport = await connectHostWebSocket(url);
const host = await createFrontendHost({ catalog, transport });
await host.dispose();
await backend.dispose();
```

For an offline build, pass the frozen assembly and static Catalog instead of a
transport. The package does not own Project, App, World, Renderer, Net
replication, or tool operation semantics. Those remain business plugins and
domain packages.

The backend owns the current assembly revision and module/code identities. A
frontend Loader update that changes a loaded module version or URL returns the
structured `host-assembly-reload-required` error and keeps the previous Loader
and its active Fibers in place. A transport close withdraws the frontend
capability: requests fail, `connected` becomes false, and the frontend status
becomes `failed` with a transport error. Consumer plugins own their domain
resources through Cordis effects; the host owns only its transport and Loader
lifetime.
