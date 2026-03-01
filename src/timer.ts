// 默认超时时间，单位毫秒
export const DEFAULT_TIMEOUT = 5000;

export const TIMEOUT_MARKER = Symbol('timeout');

export function sleep(ms: number): Promise<typeof TIMEOUT_MARKER> {
    return new Promise(resolve => setTimeout(() => resolve(TIMEOUT_MARKER), ms));
}