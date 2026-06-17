import { Command } from "commander";

// Command surface (commander). Actions are wired to core in M5; for now they are
// stubs so `--help` documents the full CLI and the skeleton runs end to end.
const program = new Command();

program
  .name("herdr-cats")
  .description(
    "Autonomous Jira→PR loop that herds Claude worker agents (\"cats\") across repos.",
  )
  .version("0.1.0")
  .option("--repo <name>", "target repo (its ~/.config/herdr-cats/repos/<name>/)");

const stub = (name: string) => () => {
  console.error(`herdr-cats ${name}: not implemented yet (in progress)`);
  process.exit(1);
};

// repo-scoped
program.command("tick").description("run one reconcile pass (what launchd invokes)").action(stub("tick"));
program.command("status").description("show active tickets + launchd state for the repo").action(stub("status"));
program.command("eligible").description("list eligible To-Do + agent-labelled tickets").action(stub("eligible"));
program.command("claim <key>").description("manually claim + start one ticket").action(stub("claim"));
program.command("teardown <key>").description("tear down one ticket's worktree").action(stub("teardown"));
program.command("worker-done <key>").description("worker signals it has finished its automated round").action(stub("worker-done"));
program.command("runs").description("list runs for the repo").option("--all", "include finished runs").action(stub("runs"));
program.command("timeline <key>").description("show the event timeline for a ticket").action(stub("timeline"));
program.command("install").description("install the repo's launchd job").action(stub("install"));
program.command("uninstall").description("remove the repo's launchd job").action(stub("uninstall"));
program.command("start").description("load the repo's launchd job").action(stub("start"));
program.command("stop").description("unload the repo's launchd job (workers keep running)").action(stub("stop"));
program.command("logs [n]").description("tail today's log for the repo").action(stub("logs"));

// repo-agnostic
program
  .command("capture-lock <action> [owner]")
  .description("machine-global dev-server/screenshot lock (acquire|release)")
  .action(stub("capture-lock"));
program.command("doctor").description("check herdr socket, gh/jira auth, db, claude").action(stub("doctor"));

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
