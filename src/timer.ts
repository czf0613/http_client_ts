export const DEFAULT_TIMEOUT = 5000;
const MAX_TIMEOUT = 2147483647;

/** 0 关闭超时；拒绝会被平台隐式改成约 1 ms 的非法值。 */
export function validateTimeout(ms: number, name: string = 'timeoutMs'): void {
    if (typeof ms !== 'number') {
        throw new TypeError(`${name} must be a number`);
    }
    if (!Number.isInteger(ms) || ms < 0 || ms > MAX_TIMEOUT) {
        throw new RangeError(`${name} must be an integer between 0 and ${MAX_TIMEOUT}; 0 disables the timeout`);
    }
}

/** 所有结束路径都清理 timer 和监听器；中止时由调用者取消实际工作。 */
export function withTimeout<T>(
    operation: () => Promise<T>,
    timeoutMs: number,
    message: string,
    signal?: AbortSignal,
    onInterrupt?: (reason: unknown) => void,
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let settled = false;

        const cleanup = () => {
            if (timer !== undefined) clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
        };
        const interrupt = (reason: unknown) => {
            if (settled) return;
            settled = true;
            cleanup();
            try {
                onInterrupt?.(reason);
            } catch {
                // 清理失败不应掩盖原本的超时/取消原因或从 timer 回调泄漏异常。
            }
            reject(reason);
        };
        const abort = () => interrupt(signal!.reason);

        if (signal?.aborted) {
            interrupt(signal.reason);
            return;
        }
        signal?.addEventListener('abort', abort, { once: true });
        if (timeoutMs > 0) {
            timer = setTimeout(() => {
                const error = new Error(message);
                error.name = 'TimeoutError';
                interrupt(error);
            }, timeoutMs);
        }

        try {
            operation().then(value => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(value);
            }, error => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(error);
            });
        } catch (error) {
            settled = true;
            cleanup();
            reject(error);
        }
    });
}
