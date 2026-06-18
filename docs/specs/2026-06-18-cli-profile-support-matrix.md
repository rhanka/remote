# Remote CLI profile support matrix

Finalite: remote ne doit pas etre un outil a deux vitesses; les agents supportes
doivent avoir des capacites explicites, testees, ou marquees unsupported avec
raison.

| Profil    | run local `remote run` | run remote `remote <profile>`             | resume `-r`                                        | auth bundle/status                                                 | plugin/MCP                                                                  | h2a instance/bridge              | jobs/delegate                                                  | restore/session state                                       |
| --------- | ---------------------- | ----------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------- |
| `claude`  | supported              | supported                                 | supported: `--resume <id>` / `--continue`          | supported: `.claude/*`, `claude auth status`                       | supported                                                                   | supported: `claude:remote:<id>`  | supported                                                      | supported: `.claude/projects`                               |
| `codex`   | supported              | supported                                 | supported: `resume <id>` / `resume --last`         | supported: `.codex/*`, `codex login status`                        | supported                                                                   | supported: `codex:remote:<id>`   | supported                                                      | supported: `.codex/sessions`                                |
| `agy`     | supported              | supported                                 | supported: `--resume <id>` / `--continue`          | partial: Gemini shared files, no noninteractive status             | supported via `.gemini/config/mcp_config.json`                              | supported: `agy:remote:<id>`     | interactive supported; headless unsupported (no verified mode) | supported: `.gemini/antigravity-cli/conversations`          |
| `gemini`  | supported              | supported if the image contains `gemini`  | unsupported until a stable resume argv is verified | partial: Gemini shared files, no noninteractive status             | gap: no dedicated Gemini MCP writer yet; shares config only when compatible | supported: `gemini:remote:<id>`  | unsupported until job argv/headless semantics are verified     | supported for `.gemini/gemini-cli/conversations` only       |
| `mistral` | supported              | supported if the image contains `mistral` | unsupported until a stable resume argv is verified | unsupported: no known local auth file/status contract in this repo | unsupported: no known MCP config contract in this repo                      | supported: `mistral:remote:<id>` | unsupported until job argv/headless semantics are verified     | unsupported: no known durable conversation dir in this repo |

Implementation decisions:

- `CLI_PROFILES` now includes `gemini` and `mistral`, so protocol schemas,
  local wrappers, remote sessions, auth loops, and session-agent profile
  dispatch share one contract.
- `-r/--resume` now fails explicitly for profiles without a verified resume
  argv. This avoids silent fresh conversations being misreported as continuity.
- `remote h2a ping <instance>` queues a real `h2a.ping` envelope in the h2a
  inbox; `--bridge` can immediately push it to `*:remote:<sessionId>`.
- Codex tmux image paste is a Wayland bridge: Ctrl+V on a Codex pane saves a
  clipboard image under `.remote/images` in the pane cwd and pastes the file path.

Second review notes:

- Correctness: Mistral is intentionally added as a runnable profile but not as a
  fully equivalent agent. Unknown auth, MCP, restore and resume contracts are
  marked unsupported rather than guessed.
- UX/scripts: the no-arg menu is TTY-only; non-interactive `remote` keeps the
  normal Commander behavior and cannot hang scripts.
