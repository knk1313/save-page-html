# CLAUDE.md

ルールの本体は[AGENTS.md](AGENTS.md)に置く（Codexなどと共有する単一のソース）。本ファイルはClaude Code用の薄いラッパーである。`@AGENTS.md`の構文で、本体の規約をセッション開始時にコンテキストへ展開する。

Claude Code固有の補助（skills、agents、slash commands）は`.claude/`配下に置く。個人のローカル設定は`.claude/settings.local.json`に置き、`.gitignore`に登録してある。

@AGENTS.md
