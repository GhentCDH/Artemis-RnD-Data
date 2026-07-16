import { rm } from "node:fs/promises";
import { join } from "node:path";
import { BUILD_DIR } from "./paths";

/** Removes root artifacts retired from preprocessing but possibly restored from a prior build-state branch. */
export async function pruneRetiredBuildOutputs(): Promise<void> {
  await Promise.all([
    rm(join(BUILD_DIR, "about.json"), { force: true }),
    rm(join(BUILD_DIR, "attribution-logos"), { recursive: true, force: true }),
  ]);
}
