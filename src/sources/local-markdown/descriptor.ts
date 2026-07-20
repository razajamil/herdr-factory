import { z } from "zod";
import { LocalMarkdownSource } from "../../clients/local-markdown-source.ts";
import { expandHome } from "../../paths.ts";
import type { SourceDescriptor } from "../registry.ts";
import { commonSourceFields } from "../common.ts";

/** Resolved local_markdown-source config. */
export interface LocalMarkdownSourceCfg {
  folder: string; // ~ / $HOME expanded
}

// A folder of *.md files, each one work item. Lifecycle is tracked internally in the work_items
// table (herdr-factory owns the status of record here).
const LocalMarkdownBlockSchema = z.object({
  folder: z.string({ error: "set `local_markdown.folder` to a directory of *.md task briefs (~ and $HOME expand)" }).trim().min(1, "`local_markdown.folder` cannot be empty"),
});

export const localMarkdownDescriptor: SourceDescriptor<LocalMarkdownSourceCfg> = {
  type: "local_markdown",
  configSchema: z
    .object({ type: z.literal("local_markdown"), ...commonSourceFields, local_markdown: LocalMarkdownBlockSchema })
    .strict(),
  resolveConfig(parsed) {
    const s = parsed as unknown as { local_markdown: { folder: string } };
    return { folder: expandHome(s.local_markdown.folder) };
  },
  create(ctx) {
    return new LocalMarkdownSource(ctx.cfg.folder, ctx.store, ctx.repoName, ctx.sourceName, ctx.log);
  },
  customStatusKeys: () => [], // internal-ledger: canonical states only (custom would need a work_items CHECK migration)
  secrets: [],
  tui: {
    defaultBlock: () => ({ folder: "" }),
    fields: [{ label: "folder", path: ["local_markdown", "folder"], placeholder: "~/dev/work-items" }],
  },
};
