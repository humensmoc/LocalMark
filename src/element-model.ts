import { z } from "zod";

const identity = z.object({
  name: z.enum(["id", "data-id", "data-key", "data-item-id", "data-testid"]),
  value: z.string().min(1).max(500),
});
export const ElementAnchorSchema = z.object({
  kind: z.literal("element"),
  tag: z.string().regex(/^[a-z][a-z0-9-]*$/).max(100),
  path: z.string().min(1).max(4000),
  identity: z.array(identity).max(5),
  // A readable snapshot is independent of the editable annotation text.
  exact: z.string().min(1).max(4000),
  text: z.string().max(2000),
  label: z.string().max(500),
  resources: z.array(z.string().max(4000)).max(4),
  context: z.array(z.object({
    tag: z.string().regex(/^[a-z][a-z0-9-]*$/).max(100),
    identity: z.array(identity).max(5),
    text: z.string().max(500),
  })).max(3),
});
export type ElementAnchor = z.infer<typeof ElementAnchorSchema>;
