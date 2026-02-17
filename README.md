# @czf0613/http_client

A simple HTTP client library built with fetch API, supporting a modified SSE (Server-Sent Events) protocol for browser environments.

## Requirements

- **Runtime**: ES2018+ compatible browsers
- **Module System**: ES Module only (not compatible with CommonJS)
- **Environment**: Browser only (Chrome, Firefox, Safari)
- **Browser Support**: Works well on all major modern browsers

## Installation

Install the package using your preferred package manager:

```bash
# npm
npm install @czf0613/http_client

# pnpm
pnpm add @czf0613/http_client

# yarn
yarn add @czf0613/http_client
```

## Usage

### `joinUrlWithParams`

Concatenates a URL with query parameters, automatically handling URL encoding.

**Parameters:**
- `url` (string): The base URL without any query parameters
- `queryParams` (Record<string, string | number | boolean>): Query parameters as key-value pairs

**Returns:** string - The complete URL with query parameters

**Example:**

```javascript
import { joinUrlWithParams } from '@czf0613/http_client';

const url = joinUrlWithParams('https://api.example.com/users', {
  page: 1,
  limit: 10,
  search: 'hello world'
});
// Result: 'https://api.example.com/users?page=1&limit=10&search=hello%20world'

// Automatic URL encoding for special characters
const url2 = joinUrlWithParams('https://api.example.com/search', {
  keyword: '你好世界'
});
// Result: 'https://api.example.com/search?keyword=%E4%BD%A0%E5%A5%BD%E4%B8%96%E7%95%8C'
```

### `makeHttpRequest`

Makes an HTTP request with default configuration using the Fetch API.

**Parameters:**
- `url` (string): The request URL (without query parameters)
- `method` (HttpMethod): HTTP method ('GET', 'POST', 'PUT', 'DELETE', 'HEAD'). Default: 'GET'
- `queryParams` (Record<string, string | number> | null): Query parameters to be appended to the URL. Default: null
- `customHeaders` (Record<string, string> | null): Custom headers (Content-Type is handled automatically). **Important: Do NOT include Content-Type in customHeaders as it will interfere with the automatic Content-Type generation.** Default: null
- `body` (any | null): Request body for POST/PUT requests. Default: null
  - String or number: sent as `text/plain`
  - Object: sent as `application/json`
  - FormData: sent as `multipart/form-data`
- `timeoutMs` (number): Timeout in milliseconds. Default: 5000

**Returns:** Promise<Response> - Fetch API Response object

**Note:** This function does not handle exceptions by default. You should wrap it in a try-catch block.

**Example:**

```javascript
import { makeHttpRequest } from '@czf0613/http_client';

// GET request with query parameters
const response = await makeHttpRequest(
  'https://api.example.com/users',
  'GET',
  { page: 1, limit: 10 }
);
const data = await response.json();

// POST request with JSON body
const response = await makeHttpRequest(
  'https://api.example.com/users',
  'POST',
  null,
  null,
  { name: 'John', age: 30 }
);

// POST request with FormData
const formData = new FormData();
formData.append('file', fileInput.files[0]);
const response = await makeHttpRequest(
  'https://api.example.com/upload',
  'POST',
  null,
  null,
  formData
);

// Custom timeout
const response = await makeHttpRequest(
  'https://api.example.com/slow-endpoint',
  'GET',
  null,
  null,
  null,
  10000 // 10 seconds timeout
);
```

### `makeSSERequest`

Makes an SSE (Server-Sent Events) request and returns an async generator that yields streaming responses. This is an enhanced version of the browser's EventSource with additional features, but it's not fully compatible with the standard SSE protocol.

**Parameters:**
- `url` (string): The request URL (without query parameters)
- `method` (HttpMethod): HTTP method ('GET', 'POST', 'PUT', 'DELETE', 'HEAD'). Default: 'GET'
- `queryParams` (Record<string, string | number> | null): Query parameters to be appended to the URL. Default: null
- `customHeaders` (Record<string, string> | null): Custom headers. **Important: Do NOT include Content-Type in customHeaders.** Default: null
- `body` (any | null): Request body for POST/PUT requests. Default: null

**Note:** For detailed parameter descriptions, see [`makeHttpRequest`](#makehttprequest) above. This function only handles responses in the format `data: xxx\n\n`. It does not throw exceptions by default; success/failure is indicated in the generator's return value.

**Returns:** AsyncGenerator<string, boolean, undefined> - An async generator that yields each message as a string, and returns a boolean indicating success (true) or failure (false)

**Example:**

```javascript
import { makeSSERequest } from '@czf0613/http_client';

async function streamChat() {
  const generator = makeSSERequest(
    'https://api.example.com/chat',
    'POST',
    null,
    null,
    { message: 'Hello' }
  );

  // Manually iterate to receive chunks
  while(true) {
    const { done, value } = await generator.next();

    if (done) {
      // Check if the stream completed successfully
      if (!value) {
        console.error('SSE stream failed');
      }

      break;
    }

    // Get the message value
    console.log('Received:', value);
  }
}
```

## License

MIT
