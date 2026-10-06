# @czf0613/http_client

[![CI](https://github.com/czf0613/http_client_ts/actions/workflows/ci.yml/badge.svg)](https://github.com/czf0613/http_client_ts/actions/workflows/ci.yml)

A small Fetch wrapper with response-header timeouts, optional body-read timeouts, cancellation, and SSE streaming. Written in TypeScript, with ES modules, declaration files, and no runtime dependencies.

## Installation and runtime

```sh
npm install @czf0613/http_client
```

Use native ESM in Node or a browser application with a bundler. The runtime must supply `fetch`, `Headers`, `Response`, `AbortController` / `AbortSignal`, `ReadableStream`, `TextDecoder`, `URLSearchParams`, and timers. Body types such as `FormData` and `Blob` require the corresponding runtime APIs. Library code does not depend on Node-specific modules, `window`, or `document`.

Response readers depend on the runtime's native implementation. In particular, **`bytes()` and `bytesWithTimeout()` require native `Response.bytes()`**; there is no polyfill or fallback. An environment without it can still import the package and use other supported methods. The unavailable method fails only when called.

The regression suite has been verified locally on Node **22.21.1**. GitHub Actions runs the same suite on Ubuntu with Node **22 and 24**; see the CI badge for current results. These are test targets, not a declared minimum. A browser/version compatibility matrix and CommonJS distribution are not provided.

## Quick start

```js
import { makeHttpRequest } from '@czf0613/http_client';

try {
    const response = await makeHttpRequest(
        'https://api.example.com/users',
        'GET',
        { page: 1, active: true },
    );
    // Ordinary HTTP requests return 4xx/5xx responses, just like fetch().
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const users = await response.jsonWithTimeout(5000);
    console.log(users);
} catch (error) {
    // Network, timeout, cancellation, or body conversion failure.
    console.error(error);
}
```

`json()`, `text()`, `arrayBuffer()`, `blob()`, `bytes()`, and `formData()` remain available without an added read timeout. TypeScript callers can use `jsonWithTimeout<T>()`; `T` does not validate the received data.

## Public API

The package root exports `joinUrlWithParams`, `makeHttpRequest`, and `makeSSERequest`. It also exports the types `HttpMethod` and `ExtendedResponse`; `ExtendedResponse` is **not** a runtime constructor export. Obtain responses from `makeHttpRequest()` or `response.clone()`.

### Timeouts and cancellation

Every timeout accepts an integer from **0 to 2147483647 milliseconds**. **`0` disables that timeout**; omission or `undefined` uses the default. Negative numbers, fractions, `NaN`, `Infinity`, and larger values reject with `RangeError`; non-numbers reject with `TypeError`.

Validation happens before sending a request or consuming a response body. An SSE generator validates when iteration starts. Timeout failures are `Error` objects with `name === 'TimeoutError'`. Timers are cleared on success, failure, and cancellation.

| Parameter | Default | Scope |
| --- | --- | --- |
| HTTP `timeoutMs` | 5000 ms | From calling Fetch until response headers arrive |
| Five `*WithTimeout(ms)` readers | 5000 ms | The complete body-read operation, from calling that reader |
| SSE `connectTimeoutMs` | 30000 ms | Until response headers arrive |
| SSE `messageTimeoutMs` | 30000 ms | Each individual `reader.read()` call |

The header timer ends when headers arrive; it does not cover the body. SSE chunks, including comments or incomplete events, satisfy individual reads. There is no whole-event deadline, and time spent in the consumer between iterations is not counted. These are event-loop timers, not a way to interrupt synchronous JavaScript work.

Both request helpers accept an optional `AbortSignal` after their timeout arguments. It can cancel a request waiting for headers and remains effective while its body is open. Abort failures preserve `signal.reason`. Use a fresh signal for a new request after aborting.

### `joinUrlWithParams(url, queryParams)`

Accepts a string URL and `Record<string, string | number | boolean>`, and returns a string. It merges existing queries, replaces matching keys, and preserves the fragment. Relative URLs are supported by this helper; fetching them still depends on the runtime.

```js
import { joinUrlWithParams } from '@czf0613/http_client';

const url = joinUrlWithParams('/items?page=1#details', {
    page: 2,
    q: 'hello world',
    active: true,
});
// /items?page=2&q=hello+world&active=true#details
```

Values use `URLSearchParams` encoding, including `+` for spaces. An empty parameter object leaves the URL unchanged. Arrays, null query values, and multiple new values for one key are not supported.

### `makeHttpRequest(...)`

Signature reference, with defaults shown:

```text
makeHttpRequest(
    url: string,
    method: HttpMethod = 'GET',
    queryParams: Record<string, string | number | boolean> | null = null,
    customHeaders: Record<string, string> | null = null,
    body: any | null = null,
    timeoutMs: number = 5000,
    signal?: AbortSignal,
): Promise<ExtendedResponse>
```

`HttpMethod` is `'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'`. The public headers argument is a plain string record. There is no general `RequestInit` argument or automatic retry.

Headers are copied, so shared or frozen input objects are safe. Header names are handled case-insensitively. An explicit Content-Type is preserved except for `FormData`, where Fetch must generate the multipart boundary.

| Body | Sent value | Default Content-Type |
| --- | --- | --- |
| `null` / `undefined` | No body | None added |
| String / number | String value | `text/plain` |
| Plain object / array | `JSON.stringify(body)` | `application/json` |
| `FormData` | Unchanged | Removes the copied Content-Type; Fetch supplies the boundary |
| `Blob` / `URLSearchParams` | Unchanged | Supplied by Fetch from the body type |
| `ArrayBuffer` / typed array / `DataView` | Unchanged | None added |

Other top-level body values, including booleans, `Date` objects, and upload streams, reject with `TypeError`. Native body objects should come from the runtime's Web API implementation. Fetch still enforces its own rules, including no body for GET or HEAD.

```js
import { makeHttpRequest } from '@czf0613/http_client';

const controller = new AbortController();
const response = await makeHttpRequest(
    'https://api.example.com/users/1',
    'PATCH',
    null,
    { Accept: 'application/json' },
    { name: 'Ada' },
    10000,
    controller.signal,
);
const updatedUser = await response.jsonWithTimeout(5000);
// controller.abort() can also interrupt the request or a pending body read.
```

HTTP error statuses are returned normally; check `response.ok`. Network errors, header timeouts, and cancellation reject the request promise.

### `ExtendedResponse`

The wrapper explicitly exposes native-style response properties and bound methods. It preserves `ok`, `status`, `statusText`, `url`, `redirected`, and `type`, and exposes `headers`, `body`, and `bodyUsed`. `clone()` returns another extended response with independent headers and a native cloned body branch.

It is not a native `Response` subclass: `instanceof Response` and native brand checks are not compatibility guarantees. Normal object properties and reflection behave consistently. Methods have stable references and can be called after destructuring.

| Extra method | Result |
| --- | --- |
| `jsonWithTimeout<T>(ms?)` | `Promise<T>` |
| `textWithTimeout(ms?)` | `Promise<string>` |
| `arrayBufferWithTimeout(ms?)` | `Promise<ArrayBuffer>` |
| `blobWithTimeout(ms?)` | `Promise<Blob>` |
| `bytesWithTimeout(ms?)` | `Promise<Uint8Array<ArrayBuffer>>` |

Conversions use native Response readers. Parsing and stream errors propagate. There is no `formDataWithTimeout()`.

Native single-consumption rules apply: clone before reading, and consume each branch only once. A body-read timeout **cancels the current branch** and releases its reader lock. It does not make that body reusable, and it does not cancel sibling clones still in use. If every branch is cancelled, the underlying stream is cancelled. In contrast, the request's external AbortSignal cancels the shared incoming stream and therefore affects all open branches.

Consumers should read or cancel bodies they no longer need, including unused clones. A live clone can keep the shared source active and buffer data even after another branch times out.

### `makeSSERequest(...)`

```text
makeSSERequest(
    url: string,
    method: HttpMethod = 'GET',
    queryParams: Record<string, string | number | boolean> | null = null,
    customHeaders: Record<string, string> | null = null,
    body: any | null = null,
    connectTimeoutMs: number = 30000,
    messageTimeoutMs: number = 30000,
    signal?: AbortSignal,
    maxEventBytes: number = 8388608,
): AsyncGenerator<string, boolean, undefined>
```

The request starts on iteration. Request preparation matches `makeHttpRequest`; `Accept: text/event-stream` is added unless the caller supplies an Accept header. The response Content-Type is not enforced.

```js
import { makeSSERequest } from '@czf0613/http_client';

const controller = new AbortController();
try {
    for await (const data of makeSSERequest(
        'https://api.example.com/chat',
        'POST',
        null,
        null,
        { message: 'Hello' },
        30000,
        10000, // Use 0 when a read may wait indefinitely.
        controller.signal,
    )) {
        if (data === '[DONE]') break; // Optional application convention.
        console.log(data);
    }
} catch (error) {
    console.error(error);
}
// Call controller.abort() from the application's cancel action.
```

SSE failures throw into `try/catch`, including when consumed with `for await`. A non-OK status produces an error named `HTTPError` with `status` and `statusText`. Missing bodies, stream errors, timeouts, and cancellation also throw. The library does not log errors. Normal exhaustion returns `true`; there is no failure `false` result.

The parser supports UTF-8 across chunks, LF / CRLF / CR line endings, one initial BOM, comment heartbeats, optional single spaces after `:`, empty data fields, and multiline data joined by `\n`. It removes only the one protocol separator space and preserves payload whitespace. Blank lines finish events. Incomplete events at EOF are discarded, following the [SSE parsing rules](https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream).

The iterator yields data strings. It ignores `event`, `id`, `retry`, and unknown fields, does not reconnect, and treats `[DONE]` as ordinary payload. It can send an HTTP request body when opening a stream; it does not provide a server-side SSE writer.

`maxEventBytes` bounds the UTF-8 wire bytes in one event's lines, **excluding line endings** and including comments and ignored fields. It resets on a blank line and defaults to **8 MiB**. Pass a positive safe integer as the ninth argument to change it; exceeding the cap throws `RangeError` and cancels the stream. The parser scans incrementally instead of copying and rescanning all buffered input after every chunk.

`break` or `.return()` from a suspended yield cancels the unused body. To interrupt a pending `.next()` / `reader.read()`, abort the signal: async generators queue `.return()` behind an already-running read.

## Changes from the earlier implementation

SSE errors now throw instead of returning `false`; callers should use `try/catch`. Payloads no longer retain the protocol separator space, multiline data is joined correctly, and incomplete EOF events are discarded. Timeouts cancel work and clean up timers; `0` disables a deadline and invalid values are rejected. Headers are no longer mutated, existing URL queries are merged, and native binary/form bodies retain their content. The SSE event-size limit is new.

## Development

```sh
npm ci
npm test
```

`npm test` builds with TypeScript, then runs JavaScript tests with native `node --test`. Tests import the compiled public entry, use synthetic streams and a local HTTP server, and install a locally packed tarball offline to verify import by package name. They do not access third-party services or use a TypeScript runtime loader.

[CI](.github/workflows/ci.yml) runs `npm ci` and `npm test` on pushes to `master`, pull requests, and manual dispatches. Both Node versions run independently, including the local HTTP and packed-package checks.

[Publish npm](.github/workflows/publish.yml) runs when a stable GitHub Release is published. It checks that the release tag matches the package version, runs the build and tests, and publishes using npm Trusted Publishing (OIDC). See the [release procedure](docs/development.md#自动发布到-npm).

`npm run build` generates ignored `dist/` JavaScript and declarations. `npm pack --dry-run` builds and previews package contents without publishing.

- [Architecture](docs/architecture.md)
- [Development and verification](docs/development.md)
- [Bug fixes and agreed behavior](docs/bug-audit.md)
- [Coding-agent instructions](AGENTS.md)

## License

[MIT](LICENSE)
