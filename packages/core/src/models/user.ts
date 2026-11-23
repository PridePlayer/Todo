import { z } from 'zod';

/**
 * 对外暴露的用户形状。
 * 密码哈希、锁定计数这类服务端字段永远不出现在这里 —— 这是白名单，不是黑名单。
 */
export const sessionUserSchema = z.object({
  id: z.string().min(1),
  email: z.string().email(),
  createdAt: z.number().int().nonnegative(),
});

export type SessionUser = z.infer<typeof sessionUserSchema>;
