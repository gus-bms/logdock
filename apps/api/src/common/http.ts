// express 타입에 기대지 않으려고 Node http 타입에 필요한 칸만 더한다(express가 이 위에 만들어진다).
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { SessionInfo } from '../auth/session.service.js';

export interface ApiRequest extends IncomingMessage {
  body?: unknown;
  /** 요청 참조. 자체 로그와 오류 본문의 request_id다(4.1절 자체 로그). */
  requestId?: string;
  /** 검사 지점을 지난 요청의 세션. */
  session?: SessionInfo;
  /** 검사 지점이 읽은 세션 쿠키 원문. 로그아웃·세션 확인이 쓴다. */
  sessionToken?: string;
}

export type ApiResponse = ServerResponse;

export function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/** 쿠키 헤더에서 이름 하나를 읽는다. 값은 그대로 돌려준다. */
export function readCookie(req: IncomingMessage, name: string): string | undefined {
  const raw = header(req, 'cookie');
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

export function appendSetCookie(res: ServerResponse, cookie: string): void {
  res.appendHeader('Set-Cookie', cookie);
}

/** 접속 주소. 앞단 프록시 설정은 설치 때 정한다(지금은 소켓 주소만 쓴다). */
export function clientAddress(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}
