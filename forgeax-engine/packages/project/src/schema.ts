// schema.ts — GameProjectSchema + GuidString refinement (D-4, D-7)
//
// Final project fields: id, name, schemaVersion=2.0.0, optional defaultScene,
// and the required persistent plugins Entry tree. .strict() rejects unknown fields.
//
// D-7: GuidString refinement lives here (engine-project), calls
// AssetGuid.parse from engine-pack, translates PackError to zod error message.

import { AssetGuid } from '@forgeax/engine-pack/guid';
import { z } from 'zod';

// ── GuidString: zod refinement calling AssetGuid.parse (AC-04) ──────────────
export const GuidString = z.string().refine(
  (val) => AssetGuid.parse(val).ok,
  (val) => {
    const parsed = AssetGuid.parse(val);
    const message = !parsed.ok ? parsed.error.hint : `invalid GUID: ${val}`;
    return { message };
  },
);

export const PluginRealmSchema = z.enum(['host', 'engine', 'build']);

const PluginInjectSchema = z.union([
  z.array(z.string().min(1)),
  z.record(z.string().min(1), z.unknown()),
]);

const PluginEntryBase = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Pure Tool Runtime contract; the executor is loaded only on invocation. */
  commandContract: z.string().min(1).optional(),
  disabled: z.boolean().optional(),
  inject: PluginInjectSchema.optional(),
  realm: PluginRealmSchema.optional(),
});

export interface GameProjectPluginEntry {
  readonly id: string;
  readonly name: string;
  readonly commandContract?: string | undefined;
  readonly config?: unknown;
  readonly group?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  readonly inject?: readonly string[] | Readonly<Record<string, unknown>> | undefined;
  readonly realm?: z.infer<typeof PluginRealmSchema> | undefined;
}

export const GameProjectPluginEntrySchema: z.ZodType<GameProjectPluginEntry> = z.lazy(() =>
  z.union([
    PluginEntryBase.extend({
      group: z.literal(true),
      config: z.array(GameProjectPluginEntrySchema),
    }).strict(),
    PluginEntryBase.extend({
      group: z.literal(false).optional(),
      config: z.unknown().optional(),
    }).strict(),
  ]),
);

export const GameProjectPluginsSchema = z
  .array(GameProjectPluginEntrySchema)
  .superRefine((entries, ctx) => {
    const seen = new Set<string>();
    const visit = (items: readonly GameProjectPluginEntry[]): void => {
      for (const entry of items) {
        if (seen.has(entry.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `duplicate plugin entry id: ${entry.id}`,
          });
        }
        seen.add(entry.id);
        if (entry.group === true) visit(entry.config as readonly GameProjectPluginEntry[]);
      }
    };
    visit(entries);
  });

// ── GameProjectSchema: strict zod object (schema 2.0) ───────────────────────
// This schema is the authoritative field list for forge.json.
export const GameProjectSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    schemaVersion: z.literal('2.0.0'),
    defaultScene: GuidString.optional(),
    plugins: GameProjectPluginsSchema,
  })
  .strict();

// ── GameProject type: z.infer-derived (AC-02, AC-05) ────────────────────────
export type GameProject = z.infer<typeof GameProjectSchema>;
