Executes a given bash command and returns its output.

IMPORTANT: Do NOT use Bash to search, read, or count code. To search file contents use the Grep tool; to find or count files by name use the Glob tool; to read a file use the Read tool. Avoid `grep`, `rg`, `find`, `fd`, `ls`, `cat`, `head`, `tail`, and `wc` here unless a dedicated tool genuinely cannot do the job. Reserve Bash for real shell work (builds, tests, git, package managers, moving files).

Output you (the model) receive is capped at ~64KB / 1000 lines (whichever first). For commands that may produce more, bound the output yourself with `head -c`, `head -n`, `tail`, or `sed -n '1,200p'` : pre-bounding gives usable signal: the post-hoc cap is lossy and includes a structured truncation notice for resume.

Separately, the user's transcript previews ONLY THE FIRST ~10 LINES of body and summarizes the rest as `shown N/M L`. Do NOT use Bash to render visual content for the user (ASCII art, banners, ANSI TUI previews, formatted tables, generated reports) : they will only see a fraction. To show visual content, put it in your text reply instead, which the user reads in full. When the TUI preview clamped more lines than the API cap did, you will receive a `<ma::agent::output-preview shown=N total=M>` annotation on the tool_result so the divergence is visible to you on the next turn.

The working directory persists between commands, but shell state does not.
