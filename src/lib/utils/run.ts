export async function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; stdio?: "pipe" | "inherit" } = {},
): Promise<void> {
  // "inherit" streams the child's output straight to the terminal — used for
  // long tools (gdal2tiles) so their native progress bar is visible live.
  if (options.stdio === "inherit") {
    const proc = Bun.spawn([command, ...args], { cwd: options.cwd, stdout: "inherit", stderr: "inherit" });
    const exitCode = await proc.exited;
    if (exitCode !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit ${exitCode}`);
    return;
  }

  const proc = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  if (exitCode !== 0) {
    const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed with exit ${exitCode}${output ? `\n${output}` : ""}`);
  }
}
