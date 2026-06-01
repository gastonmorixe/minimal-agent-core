Search file contents with regex, built on ripgrep.

ALWAYS use this tool for content searches, including counting matches (use `output_mode: "count"`). NEVER invoke `grep` or `rg` as a Bash command: this tool is faster, respects .gitignore, and returns cleaner, bounded output.

Output you (the model) receive is capped at ~64KB / 1000 lines. The user's transcript previews only the first ~12 lines and summarizes the rest. For broad searches, prefer `output_mode: "files_with_matches"` (paths only : densest) or `"count"`. Narrow with `glob` (e.g. "*.ts"), `path` (subdirectory), `-A/-B/-C` for context lines, or `head_limit` rather than relying on the cap to fire.
