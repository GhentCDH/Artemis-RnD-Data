import { copyFile } from "node:fs/promises";
import { dirname } from "node:path";
import { BUILD_MAP_SERVICES_YAML_PATH, mapServicesYamlPath } from "../paths";
import { ensureDir } from "../utils/files";
import { log } from "../log";
import type { BuildLog } from "../build/buildLog";

export async function publishMapServices(options: { buildLog?: BuildLog } = {}): Promise<void> {
  await ensureDir(dirname(BUILD_MAP_SERVICES_YAML_PATH));
  await copyFile(mapServicesYamlPath(), BUILD_MAP_SERVICES_YAML_PATH);
  log.ok(`map services: published ${BUILD_MAP_SERVICES_YAML_PATH}`);
  await options.buildLog?.section("Map services");
  await options.buildLog?.fields({ "map-services.yaml published": "yes" });
}
