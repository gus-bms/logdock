// 검색 요청 본문(계약 4.2절). 조건·시간은 저장 검색·알림 규칙과 같은 꼴이다(SD-30).
import { z } from 'zod';

import { ConditionSchema, TimeSchema } from './condition.js';

export const SearchBody = z
  .object({
    run_id: z.string().uuid(),
    condition: ConditionSchema,
    time: TimeSchema,
    sort: z.enum(['newest', 'oldest']).optional(),
    page_size: z.number().int().positive().optional(),
  })
  .strict();
export type SearchBody = z.infer<typeof SearchBody>;

export const PageBody = z.object({ cursor: z.string().min(1).max(2048) }).strict();
export const UnknownBody = z.object({ cursor: z.string().min(1).max(2048).optional() }).strict();
export const EmptyBody = z.object({}).strict();
