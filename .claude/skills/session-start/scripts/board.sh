#!/bin/sh
# LogDock docs/agent 작업 보드를 출력한다. 파일을 고치지 않는다.
# --hook: SessionStart hook에서 부를 때 안내 문구를 앞에 붙인다.

root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
dir="$root/docs/agent"

if [ "$1" = "--hook" ]; then
  echo "LogDock 새 세션이다. 사용자의 첫 메시지에 답하기 전에 session-start 스킬로 아래 작업 보드를 읽고 시작 보고를 한다. 첫 메시지가 구체적인 요청이면 짧은 상태만 알리고 그 요청을 진행한다."
fi

if [ ! -d "$dir" ]; then
  echo "docs/agent 폴더가 없다. 작업 문서 체계를 도입하기 전 버전의 작업 폴더일 수 있으므로 브랜치와 작업 폴더 위치를 사용자에게 알린다."
  exit 0
fi

echo "작업 보드 (docs/agent)"
for status in progress hold todo; do
  echo "[$status]"
  found=0
  for file in "$dir/$status"/*.md; do
    [ -f "$file" ] || continue
    found=1
    name=$(basename "$file" .md)
    title=$(sed -n 's/^# //p' "$file" | head -n 1)
    echo "- $name: $title"
    fields='담당|우선순위|선행|다음 할 일|막힌 이유|풀리는 조건'
    [ "$status" = "progress" ] && fields="$fields|마지막 갱신"
    grep -E "^- ($fields): " "$file" | grep -v ': 없음$' | sed 's/^- /    /'
  done
  [ "$found" -eq 1 ] || echo "  (없음)"
done
done_count=$(find "$dir/done" -maxdepth 1 -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
echo "[done] ${done_count}건. 기본으로 읽지 않는다."
exit 0
