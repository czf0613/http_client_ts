type ByteStream = ReadableStream<Uint8Array<ArrayBuffer>>;

/** 可中止的流转发层。只取消当前源分支，不等待其他 clone 分支结束。 */
export function manageBody(source: ByteStream, onFinished: () => void = () => {}, readImmediately = false) {
    const reader = source.getReader();
    let finished = false;
    let controller: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
    let pending = readImmediately ? reader.read() : undefined;
    // 中止可能发生在下游首次 pull 之前，仍需接住预先开始的读取失败。
    pending?.catch(() => {});

    const finish = () => {
        reader.releaseLock();
        onFinished();
    };
    const cancelSource = (reason: unknown): Promise<void> => {
        const cancellation = reader.cancel(reason);
        finish();
        return cancellation;
    };
    const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
        start(value) { controller = value; },
        async pull() {
            try {
                const reading = pending ?? reader.read();
                pending = undefined;
                const result = await reading;
                if (finished) return;
                if (result.done) {
                    finished = true;
                    controller.close();
                    finish();
                } else {
                    controller.enqueue(result.value);
                }
            } catch (error) {
                if (finished) return;
                finished = true;
                controller.error(error);
                finish();
            }
        },
        cancel(reason) {
            if (finished) return;
            finished = true;
            return cancelSource(reason);
        },
    }, { highWaterMark: 0 });

    return {
        stream,
        abort(reason: unknown) {
            if (finished) return;
            finished = true;
            controller.error(reason);
            // 原生 tee 的 cancel Promise 可能等待兄弟分支，不能据此阻塞超时返回。
            void cancelSource(reason).catch(() => {});
        },
    };
}
