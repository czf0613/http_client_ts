export const TIMEOUT_MARKER = Symbol('timeout');

export function sleep(ms: number): Promise<typeof TIMEOUT_MARKER> {
    return new Promise(resolve => setTimeout(() => resolve(TIMEOUT_MARKER), ms));
}