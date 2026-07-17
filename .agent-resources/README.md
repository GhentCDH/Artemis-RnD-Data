# Agent resources

The `.agent-resources/` directories in both Artemis repositories contain
internal documentation for maintainers and AI-assisted development. They record
repository responsibilities, architecture, operational constraints, and file
ownership so work starts with the same project context in either repository.
They are not application data and are never shipped to users.

The documents are plain Markdown and intentionally independent of any specific
model, vendor, editor, or agent format.

- [`context/repository.md`](context/repository.md) summarizes the pipeline,
  operational constraints, and useful debugging entry points.
- [`context/file-index.md`](context/file-index.md) maps source files and folders
  to their responsibilities.

Pass only the relevant file with a task to reduce discovery time and avoid
loading unnecessary repository content.
