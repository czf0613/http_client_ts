export const encode = value => new TextEncoder().encode(value);

export function mockFetch(t, factory) {
    return t.mock.method(globalThis, 'fetch', factory);
}

export function streamResponse(chunks) {
    return new Response(new ReadableStream({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(typeof chunk === 'string' ? encode(chunk) : chunk);
            }
            controller.close();
        },
    }));
}

export function pendingBody() {
    const state = { cancellations: [] };
    state.stream = new ReadableStream({
        start(controller) { state.controller = controller; },
        cancel(reason) { state.cancellations.push(reason); },
    });
    return state;
}

export async function collect(generator) {
    const messages = [];
    while (true) {
        const item = await generator.next();
        if (item.done) return { messages, result: item.value };
        messages.push(item.value);
    }
}

export function trackTimers(t) {
    const originalSet = globalThis.setTimeout;
    const originalClear = globalThis.clearTimeout;
    const pending = new Set();
    t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
        const timer = originalSet(() => {
            pending.delete(timer);
            callback(...args);
        }, ms);
        pending.add(timer);
        return timer;
    });
    t.mock.method(globalThis, 'clearTimeout', timer => {
        pending.delete(timer);
        originalClear(timer);
    });
    t.after(() => { for (const timer of pending) originalClear(timer); });
    return pending;
}
