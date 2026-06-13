Reads a file from the local filesystem.

For text files it returns the contents with line numbers (cat -n style), so you can cite line numbers in later Edit calls.

For image files (PNG, JPEG, GIF, WebP), it returns the actual image to you as a viewable image, not text, when the current model accepts image input. This is how you look at a screenshot, a diagram, a photo, or any image a tool wrote to disk, such as a `Computer` screenshot path: just Read the path. A huge image is automatically downscaled to fit the model's limit before it is sent, so you do not need to resize it yourself. Do not try to decode image bytes as text. If the model has no vision support, or the file is a binary document (PDF) that tool output can't carry, Read returns a short message explaining what to do instead, rather than garbled bytes.

Text output you (the model) receive is capped at ~64KB / 1000 lines per call. The user's transcript previews only the first ~15 lines and summarizes the rest. For larger files, page with `offset` (zero-based start line) and `limit` (max lines). The truncation notice reports both the cut line and total file size so you can pick the next offset. Image reads are not line-paged; `offset`/`limit` apply to text only.
