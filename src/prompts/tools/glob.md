Fast file-name and path pattern matching that works on any codebase size.

Use this tool to find or count files by name or path. Do not use `find`, `fd`, or `ls` through Bash for this. Supports glob patterns like `**/*.ts` or `src/**/*.{js,ts}`. Returns matching file paths sorted by modification time.

The glob string is `pattern`. `glob_pattern` is accepted as an alias. Search directory is `path` (defaults to cwd). `target_directory` is accepted as an alias for `path`. If both a canonical name and its alias are set, the canonical name wins.
