Reads a file from the local filesystem. Returns content with line numbers.

Output you (the model) receive is capped at ~64KB / 1000 lines per call. The user's transcript previews only the first ~15 lines and summarizes the rest. For larger files, page with `offset` (zero-based start line) and `limit` (max lines). The truncation notice reports both the cut line and total file size so you can pick the next offset.
