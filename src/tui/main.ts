const enabled = process.env.HERDR_FACTORY_TUI_TIMING === "1";
const started = performance.now();
const timings: Record<string, number> = {
  node_startup: Math.round(process.uptime() * 1000),
};

const { main } = await import("./index.ts");
timings.modules_loaded = Math.round(performance.now() - started);
await main((name) => {
  timings[name] = Math.round(performance.now() - started);
  if (enabled && name === "app_ready") {
    void import("node:fs").then(({ appendFileSync }) => {
      appendFileSync("/tmp/herdr-factory-tui-startup.log", `${JSON.stringify({ at: new Date().toISOString(), ...timings })}\n`);
    });
  }
});

export {};
