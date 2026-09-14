import type { HostPluginPair } from '@forgeax/engine-host/protocol';

export const SNAKE_HOST_VERSION = '0.0.0';

/** One backend-authoritative package pair; the client never authors its Entry list. */
export function snakeHostPair(): HostPluginPair {
  return {
    id: 'multiplayer-snake',
    backend: {
      entry: { id: 'snake:backend', name: 'snake:server' },
      module: { name: 'snake:server', realm: 'engine', version: SNAKE_HOST_VERSION },
    },
    frontend: {
      entry: {
        id: 'snake:frontend',
        name: 'snake:client',
        config: { protocolVersion: 2 },
      },
      module: { name: 'snake:client', realm: 'engine', version: SNAKE_HOST_VERSION },
    },
  };
}
