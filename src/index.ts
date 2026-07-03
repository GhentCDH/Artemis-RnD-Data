#!/usr/bin/env bun
/**
 * Artemis data pipeline (v2) — CLI entrypoint.
 *
 * Reads the authoring inputs under `Source/` and produces the published `build/`
 * tree (see DataRepoPlanning/OutputStructure.md). Stages are stubs for now.
 *
 *   bun run src/index.ts <command> [layerId...]
 */

const COMMANDS = {
  build: "Build everything (or the given layer ids) into build/",
  layers: "Merge Source/layers/* into build/layers.yaml",
  help: "Show this help",
} as const;

function help(): void {
  console.log("artemis-data (v2)\n\nCommands:");
  for (const [name, desc] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(8)} ${desc}`);
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "build":
      console.log(`[build] TODO — layers: ${args.length ? args.join(", ") : "all"}`);
      break;
    case "layers":
      console.log("[layers] TODO — enumerate Source/layers/*, resolve logos, emit build/layers.yaml");
      break;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      help();
      break;
    default:
      console.error(`Unknown command: ${command}\n`);
      help();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
