
import { startExportServer } from '../src/main/exportServer.js';

const PORT = 3001;

async function main() {
    console.log(`Starting Container Browser API Server on Port ${PORT} (Standalone mode)...`);
    try {
        startExportServer(PORT);
        console.log(`API Server is listening on Port ${PORT}.`);
    } catch (e) {
        console.error('Failed to start API Server:', e);
    }
}

main();
