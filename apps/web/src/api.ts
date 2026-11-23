import { createApiClient } from '@grid/core';

/**
 * 全局唯一的 API 客户端实例。
 * 它自己持有 CSRF token（首次 GET /auth/session 时拿到），所以调用方不需要关心。
 */
export const api = createApiClient();
