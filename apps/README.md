# Independent apps

- The repository root remains the existing Windows Agent Workbench project.
- [`linux/`](linux/README.md) is the independent Linux app, copied from Windows
  v0.1.39 and versioned separately from v0.1.0 onward.

Each app owns its source, dependencies, settings and build process. Do not turn
the root package into an npm workspace or import shared application code between
the apps without revisiting the Windows isolation decision.
