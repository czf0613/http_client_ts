import { makeHttpRequest } from '../dist/http_client';

async function testTimeout() {
    console.log('Testing timeout with a slow download endpoint...\n');

    try {
        const response = await makeHttpRequest(
            'https://vscode.download.prss.microsoft.com/dbazure/download/stable/072586267e68ece9a47aa43f8c108e0dcbf44622/VSCodeUserSetup-x64-1.109.5.exe',
            'GET',
            null,
            null,
            null,
            5000  // connect timeout 5s
        );

        console.log('Connected successfully');
        console.log('Response status:', response.status);
        console.log('Response OK:', response.ok);
        console.log('Content-Length:', response.headers.get('content-length'));
        console.log('\n--- Attempting to read body with 500ms timeout ---\n');

        const arr = await response.arrayBufferWithTimeout(500);
        console.log('ArrayBuffer length:', arr.byteLength);
        console.log('\n❌ Test failed: Expected timeout but succeeded!');
        process.exit(1);
    } catch (error) {
        if (error instanceof Error && error.message.includes('timeout')) {
            console.log('✅ Test passed: Timeout occurred as expected');
            console.log('Error message:', error.message);
        } else {
            console.error('❌ Test failed with unexpected error:', error);
            process.exit(1);
        }
    }
}

testTimeout();
