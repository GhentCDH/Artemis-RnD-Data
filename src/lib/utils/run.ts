export async function runCommand(command: string, args: string[], options: { cwd?: string } = {}): Promise<void> {
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
