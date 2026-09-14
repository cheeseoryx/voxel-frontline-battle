import { Context, type Fiber, type Plugin } from '@forgeax/engine-plugin';

/**
 * The product-neutral host bootstrap. It owns only a Cordis Context and the
 * supplied startup entries; assembly, transport, Project, and App are all
 * ordinary plugins layered above this seam.
 */
export interface HostStartupOptions {
  readonly context?: Context;
  readonly startupPlugins?: readonly Plugin[];
}

export interface HostStartup {
  readonly context: Context;
  readonly ownedContext: boolean;
  readonly fibers: readonly Fiber[];
  dispose(): Promise<void>;
}

export async function createHostStartup(options: HostStartupOptions = {}): Promise<HostStartup> {
  const context = options.context ?? new Context();
  const ownedContext = options.context === undefined;
  const fibers: Fiber[] = [];
  let disposed = false;
  try {
    for (const plugin of options.startupPlugins ?? []) fibers.push(await context.plugin(plugin));
  } catch (error) {
    for (const fiber of fibers.reverse()) await fiber.dispose();
    if (ownedContext) await context.fiber.dispose();
    throw error;
  }
  return {
    context,
    ownedContext,
    fibers,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      for (const fiber of [...fibers].reverse()) await fiber.dispose();
      if (ownedContext) await context.fiber.dispose();
    },
  };
}
