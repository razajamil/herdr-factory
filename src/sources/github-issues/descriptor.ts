import { z } from "zod";
import { GithubIssuesClient } from "../../clients/github-issues.ts";
import { GithubIssuesSource, type GithubIssuesSourceCfg } from "../../clients/github-issues-source.ts";
import type { SourceDescriptor } from "../registry.ts";

// The github_issues source's where-to-poll block. `repo` is optional: it defaults to the repo
// PRs are opened against (the resolved ghRepo), and create() THROWS when neither resolves —
// today ghRepo can silently be "" when the checkout has no origin, and a source that can never
// poll should fail at startup, not sit silently empty.
const GithubIssuesBlockSchema = z.object({
  repo: z
    .string()
    .trim()
    .regex(/^[\w.-]+\/[\w.-]+$/, "owner/name")
    .optional(),
  // The trigger label is NOT here — it's per-belt now (belt.label). It's threaded into
  // listEligible (the poll filter) AND transition (consumed on in_development) AND health.
  state_labels: z
    .object({
      in_development: z.string().trim().min(1).default("herdr:in-development"),
      in_review: z.string().trim().min(1).default("herdr:in-review"),
      aborted: z.string().trim().min(1).default("herdr:aborted"),
    })
    .strict()
    .prefault({}),
  close_on: z
    .object({
      merged: z.boolean().default(true),
      done: z.boolean().default(true),
      aborted: z.boolean().default(false), // true → close as not_planned; default keeps failures visible
    })
    .strict()
    .prefault({}),
  type_labels: z
    .record(z.string(), z.string().trim().min(1))
    .default({ bug: "Bug", defect: "Bug", chore: "Chore", task: "Chore", enhancement: "Feature" }),
  default_type: z.string().trim().min(1).default("Feature"),
  max_pages: z.coerce.number().int().min(1).max(10).default(1),
}).strict(); // an unknown key in the block is a typo (`labels:` for `state_labels`) — reject loudly

const sourceName = z.string().trim().min(1).optional();

interface GithubIssuesParsed {
  type: "github_issues";
  name?: string;
  github_issues: z.infer<typeof GithubIssuesBlockSchema>;
}

/** The resolved block, minus `repo` (finalized against ghRepo in create()). */
type ResolvedBlock = Omit<GithubIssuesSourceCfg, "repo"> & { repo?: string };

export const githubIssuesDescriptor: SourceDescriptor<ResolvedBlock> = {
  type: "github_issues",
  pickupLabel: { noun: "trigger label" },
  configSchema: z
    .object({ type: z.literal("github_issues"), name: sourceName, github_issues: GithubIssuesBlockSchema })
    .strict(),
  resolveConfig(parsed) {
    const b = (parsed as unknown as GithubIssuesParsed).github_issues;
    return {
      repo: b.repo,
      stateLabels: {
        inDevelopment: b.state_labels.in_development,
        inReview: b.state_labels.in_review,
        aborted: b.state_labels.aborted,
      },
      closeOn: b.close_on,
      // Case-insensitive matching happens at lookup; normalize the keys once here.
      typeLabels: Object.fromEntries(Object.entries(b.type_labels).map(([k, v]) => [k.toLowerCase(), v])),
      defaultType: b.default_type,
      maxPages: b.max_pages,
    };
  },
  create(ctx) {
    const repo = ctx.cfg.repo ?? ctx.ghRepo;
    if (!repo) {
      throw new Error(
        `work source "${ctx.sourceName}": no GitHub repo to poll — set github_issues.repo (owner/name), or repo.github / a git origin so the default resolves`,
      );
    }
    const client = new GithubIssuesClient(repo, ctx.env.GITHUB_TOKEN, undefined, undefined, ctx.log);
    return new GithubIssuesSource({ ...ctx.cfg, repo }, client, ctx.ghRepo || repo, ctx.log);
  },
  secrets: [
    {
      envKey: "GITHUB_TOKEN",
      required: false,
      masked: true,
      placeholder: "(optional — defaults to `gh auth token`)",
      hint: "optional PAT with issues:write on the polled repo; when unset, the gh CLI's login is used",
    },
  ],
  tui: {
    defaultBlock: () => ({}),
    fields: [
      { label: "repo", path: ["github_issues", "repo"], placeholder: "(optional; default = PR repo)" },
      { label: "state_labels.in_development", path: ["github_issues", "state_labels", "in_development"], placeholder: "herdr:in-development" },
      { label: "state_labels.in_review", path: ["github_issues", "state_labels", "in_review"], placeholder: "herdr:in-review" },
      { label: "state_labels.aborted", path: ["github_issues", "state_labels", "aborted"], placeholder: "herdr:aborted" },
      { label: "default_type", path: ["github_issues", "default_type"], placeholder: "Feature" },
      { label: "max_pages", path: ["github_issues", "max_pages"], placeholder: "1", numeric: true },
    ],
  },
};
