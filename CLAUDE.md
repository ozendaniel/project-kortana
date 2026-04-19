@AGENTS.md

# Claude Code-Specific Notes

## Session Rules

- Compact the context window whenever usage reaches 40%. Summarize key decisions and current working state before compacting.

## Environment

- **Letta (Claude Subconscious):** Running as a passive observer across Claude Code sessions to build persistent cross-session context. `.letta/` directory is gitignored — local runtime only, configure separately per machine.
