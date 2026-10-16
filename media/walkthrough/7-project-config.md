# Describe host commands (optional)

If your scripts run inside a tool that adds its own commands (Vivado, Quartus, your own framework), the extension cannot see them. A project configuration file lets you describe them:

- `commands`: signatures and descriptions for completion and hover.
- `knownCommands`: names the undefined-command check should accept.
- `hosts`: tables that apply only to matching files, such as `**/*.xdc`.

The file is plain JSON and is never executed.
