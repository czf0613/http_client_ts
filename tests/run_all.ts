import { spawn } from 'child_process';

async function runTest(file: string): Promise<boolean> {
    console.log(`\n========================================`);
    console.log(`Running: ${file}`);
    console.log(`========================================\n`);

    return new Promise((resolve) => {
        const child = spawn('npx', ['tsx', file], {
            stdio: 'inherit',
            shell: true
        });

        child.on('close', (code) => {
            if (code === 0) {
                console.log(`\n✅ ${file} passed\n`);
                resolve(true);
            } else {
                console.log(`\n❌ ${file} failed with code ${code}\n`);
                resolve(false);
            }
        });

        child.on('error', (error) => {
            console.error(`\n❌ ${file} failed with error:`, error);
            resolve(false);
        });
    });
}

async function main() {
    const tests = [
        'tests/test_bing.ts',
        'tests/test_timeout.ts'
    ];

    const results = await Promise.all(tests.map(runTest));

    console.log('\n========================================');
    console.log('Test Summary');
    console.log('========================================');

    tests.forEach((test, index) => {
        const status = results[index] ? '✅ PASSED' : '❌ FAILED';
        console.log(`${status}: ${test}`);
    });

    const allPassed = results.every(r => r);

    if (allPassed) {
        console.log('\n✅ All tests passed!');
        process.exit(0);
    } else {
        console.log('\n❌ Some tests failed!');
        process.exit(1);
    }
}

main();
