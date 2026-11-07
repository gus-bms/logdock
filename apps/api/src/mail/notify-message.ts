// 알림 메일과 운영 메일의 제목·본문(계약 5.5절 메일 형식, Q12 5절 예시, TD-14~16, Q12-11·13). 사건이 열릴 때 고정한 값으로 만든다.
// 대상은 서비스·서버·레벨만 적고 본문 검색어와 필드 값은 넣지 않는다. 시각은 표시 시간대와 UTC 오프셋을 함께 쓰고 구간은
// "이상~미만"으로 적는다. 조사 링크는 서버 설정의 기준 주소에 `/alerts/incidents/{public_ref}`만 붙이고 조건을 넣지 않는다.
import type { Condition } from '../search/condition.js';
import type { ReferenceMaps } from '../search/references.js';
import { sourcesOf } from '../search/references.js';

export interface IncidentForMail {
  public_ref: string;
  rule_name: string;
  condition: Condition;
  window_minutes: number;
  threshold: number;
  window_start: string;
  window_end: string;
  fired_at: string;
  matched_count: number;
  unknown_count: number | null;
  oldest_occurred_at: string | null;
  partial: boolean;
  quality: string;
  closed_at: string | null;
  close_reason: string | null;
}

export interface EpisodeForMail {
  kind: 'connection_unobserved' | 'alert_eval_failed' | 'disk_warning';
  started_at: string;
  service_name: string | null;
  server_display_name: string | null;
  target: string | null;
}

export interface MessageOptions {
  timezone: string;
  baseUrl: string | null;
  now: Date;
  delayNoticeSeconds: number;
}

const QUALITY: Record<string, string> = {
  complete: '완전',
  partially_unobserved: '일부 미관측',
  unmonitorable: '감시 불가',
  no_targets: '대상 없음',
};

const EPISODE: Record<EpisodeForMail['kind'], string> = {
  connection_unobserved: '수집 연결 관측 불가',
  alert_eval_failed: '알림 평가 실패',
  disk_warning: '로그 저장 공간 경고',
};

/** 표시 시간대의 `YYYY-MM-DD HH:MM:SS`와 그 시각의 UTC 오프셋(`+09:00`). */
export function localTime(iso: string, timezone: string): { text: string; offset: string } {
  const d = new Date(iso.replace(/(\.\d{3})\d+/, '$1'));
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const tz = get('timeZoneName');
  return {
    text: `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`,
    offset: tz === 'GMT' ? '+00:00' : tz.replace('GMT', ''),
  };
}

/** 사람이 넣은 값(규칙·서비스·서버 이름)의 제어 문자를 한 칸으로 바꾼다(PT12-09). */
const clean = (v: string) => v.replace(/\p{Cc}+/gu, ' ').trim();

function targetLine(cond: Condition, refs: ReferenceMaps): string {
  const s = sourcesOf(cond);
  const services = s.service_ids.map((id) => refs.services.get(id)?.name ?? `서비스 ${id}`);
  const servers = s.server_ids.map((id) => (id === null ? '서버 미입력' : (refs.servers.get(id)?.display_name ?? `서버 ${id}`)));
  const levels = (cond.levels ?? []).map((l) => (l === 'UNKNOWN' ? '미확인' : l));
  const parts = [
    services.length ? services.map(clean).join(', ') : '전체 서비스',
    servers.length ? servers.map(clean).join(', ') : '전체 서버',
    levels.length ? levels.join(', ') : '전체 레벨',
  ];
  if ((cond.body ?? []).length || (cond.fields ?? []).length) parts.push('본문·필드 조건 있음');
  return parts.join(' / ');
}

/** 알림 메일(Q12 5절 예시 형식). 늦게 나가면 제목 앞에 지연을, 사건이 닫힌 뒤면 그 사실을 적는다(Q12-11). */
export function alertMessage(inc: IncidentForMail, refs: ReferenceMaps, o: MessageOptions): { subject: string; text: string } {
  const name = clean(inc.rule_name);
  const delayMin = Math.floor((o.now.getTime() - new Date(inc.fired_at.replace(/(\.\d{3})\d+/, '$1')).getTime()) / 60000);
  const delayed = delayMin * 60 >= o.delayNoticeSeconds;
  const subject = `${delayed ? `[지연 ${delayMin}분] ` : ''}[LogDock] ${name} — ${inc.matched_count}건 / ${inc.window_minutes}분 (기준 ${inc.threshold}건)`;
  const start = localTime(inc.window_start, o.timezone);
  const end = localTime(inc.window_end, o.timezone);
  const lines = [
    `규칙: ${name}`,
    `대상: ${targetLine(inc.condition, refs)}`,
    `건수: ${inc.matched_count}건 (기준 ${inc.threshold}건 이상)${inc.partial ? ', 일부 구간만 평가' : ''}`,
    `집계 구간: ${start.text} 이상 ~ ${end.text} 미만 (${start.offset}, 중앙 수신 시각)`,
  ];
  if (inc.oldest_occurred_at) {
    const oldest = localTime(inc.oldest_occurred_at, o.timezone);
    lines.push(`가장 오래된 발생 시각: ${oldest.text} (${oldest.offset})`);
  }
  if (inc.unknown_count) lines.push(`판정 불가: ${inc.unknown_count}건`);
  lines.push(`감시 상태: ${QUALITY[inc.quality] ?? inc.quality}`);
  if (inc.closed_at) lines.push(inc.close_reason === 'condition_changed' ? '발송 시점에 규칙 조건이 바뀌어 이 사건은 닫혔습니다.' : '발송 시점에 이미 해소됨');
  lines.push('');
  if (o.baseUrl) lines.push(`조사 열기: ${o.baseUrl}/alerts/incidents/${inc.public_ref}`, '로그인이 필요합니다.');
  lines.push('현재 결과는 보존·삭제로 위 건수와 다를 수 있습니다.', '', '이 메일은 조건이 해소될 때까지 다시 오지 않으며 회복 메일은 없습니다.');
  return { subject, text: lines.join('\n') };
}

/** 운영 메일(Q12-06, TD-21). 영향 수, 원인 분류, 시작 시각, 수집 상태 화면 링크. 같은 일은 이어지는 동안 다시 싣지 않는다. */
export function opsMessage(episodes: EpisodeForMail[], o: MessageOptions): { subject: string; text: string } {
  const subject = `[LogDock] 운영 알림 — ${episodes.length}건`;
  const lines = ['아래 일이 이어지고 있습니다.', ''];
  for (const e of episodes) {
    const at = localTime(e.started_at, o.timezone);
    const what =
      e.kind === 'connection_unobserved'
        ? [e.service_name, e.server_display_name ?? '서버 미입력', e.target].filter((x): x is string => Boolean(x)).map(clean).join(' · ')
        : '';
    lines.push(`- ${EPISODE[e.kind]}${what ? `: ${what}` : ''} (시작 ${at.text} ${at.offset})`);
  }
  lines.push('');
  if (o.baseUrl) lines.push(`수집 상태 보기: ${o.baseUrl}/connections`, '로그인이 필요합니다.', '');
  lines.push('같은 일은 이어지는 동안 다시 보내지 않으며 회복 메일은 없습니다.');
  return { subject, text: lines.join('\n') };
}
