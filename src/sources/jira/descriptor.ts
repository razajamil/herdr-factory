import { z } from "zod";
import { JiraSource, type JiraSourceCfg } from "../../clients/jira-source.ts";
import type { SourceDescriptor } from "../registry.ts";

// The Jira source's where-to-poll block. base_url is the Atlassian site (not a secret; auth —
// email + token — lives in the per-repo env file, declared in the secrets manifest below). The
// pickup label is NOT here — it's per-belt now (belt.label, threaded into listEligible/health).
const JiraBlockSchema = z.object({
  base_url: z.url().transform((s) => s.replace(/\/+$/, "")),
  project: z.string(),
  board: z.coerce.string(),
  status: z
    .object({
      todo: z.string().default("To Do"),
      in_development: z.string().default("In Progress"),
      review: z.string().default("In Review"),
    })
    .prefault({}),
});

const sourceName = z.string().trim().min(1).optional();

/** Raw parse output of the jira source object (post-zod, pre-resolve). */
interface JiraParsed {
  type: "jira";
  name?: string;
  jira: z.infer<typeof JiraBlockSchema>;
}

export const jiraDescriptor: SourceDescriptor<JiraSourceCfg> = {
  type: "jira",
  pickupLabel: { noun: "label" },
  configSchema: z.object({ type: z.literal("jira"), name: sourceName, jira: JiraBlockSchema }).strict(),
  resolveConfig(parsed) {
    const s = parsed as unknown as JiraParsed;
    return {
      baseUrl: s.jira.base_url,
      project: s.jira.project,
      board: s.jira.board,
      statusTodo: s.jira.status.todo,
      statusInDev: s.jira.status.in_development,
      statusReview: s.jira.status.review,
    };
  },
  create(ctx) {
    return new JiraSource(ctx.cfg, ctx.env.JIRA_EMAIL ?? "", ctx.env.JIRA_API_TOKEN ?? "");
  },
  secrets: [
    { envKey: "JIRA_EMAIL", required: true, placeholder: "you@org.com", hint: "the Atlassian account email for API auth" },
    { envKey: "JIRA_API_TOKEN", required: true, masked: true, hint: "an Atlassian API token (id.atlassian.com → Security → API tokens)" },
  ],
  tui: {
    defaultBlock: () => ({
      base_url: "",
      project: "",
      board: "",
      status: { todo: "To Do", in_development: "In Progress", review: "In Review" },
    }),
    fields: [
      { label: "jira.base_url", path: ["jira", "base_url"], placeholder: "https://org.atlassian.net" },
      { label: "jira.project", path: ["jira", "project"], placeholder: "PROJ" },
      { label: "jira.board", path: ["jira", "board"], placeholder: "123" },
      { label: "status.todo", path: ["jira", "status", "todo"], placeholder: "To Do" },
      { label: "status.in_development", path: ["jira", "status", "in_development"], placeholder: "In Progress" },
      { label: "status.review", path: ["jira", "status", "review"], placeholder: "In Review" },
    ],
  },
};
