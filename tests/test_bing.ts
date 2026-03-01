import { makeHttpRequest } from '../dist/http_client';

async function testBing() {
    console.log('Testing HTTP client with bing.com...\n');

    try {
        const response = await makeHttpRequest('https://www.bing.com');

        console.log('Response status:', response.status);
        console.log('Response OK:', response.ok);
        console.log('Response URL:', response.url);
        console.log('Content-Type:', response.headers.get('content-type'));
        console.log('\n--- HTML Content ---\n');

        const text = await response.text();
        console.log(text);
        console.log('\n✅ Test passed!');
    } catch (error) {
        console.error('❌ Test failed:', error);
        process.exit(1);
    }
}

testBing();
