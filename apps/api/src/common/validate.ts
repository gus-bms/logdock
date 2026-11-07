import type { z } from 'zod';

import { errors } from './api-error.js';

/** zod 스키마로 입력을 검사한다. 실패하면 칸 경로와 이유를 담은 422 validation_failed다(4.5절). */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input ?? {});
  if (r.success) return r.data;
  throw errors.validation(
    r.error.issues.map((i) => ({ path: i.path.map(String).join('.'), reason: i.code })),
  );
}

/** 경로의 정수 ID. 정수가 아니면 그런 대상이 없는 것으로 본다. */
export function idParam(raw: string): number {
  if (!/^[1-9][0-9]{0,9}$/.test(raw)) throw errors.notFound();
  const id = Number(raw);
  if (id > 2147483647) throw errors.notFound();
  return id;
}
