#!/usr/bin/env node
import http from 'node:http';
import readline from 'node:readline';
import crypto from 'node:crypto';

/**
 * MCP Bridge for Container Browser
 * Translates MCP JSON-RPC over stdio to HTTP API calls.
 */

const PORT = process.env.CONTAINER_EXPORT_PORT || 3001;
const API_BASE = `http://localhost:${PORT}`;
const HMAC_SECRET = process.env.REMOTE_EXEC_HMAC;

async function callApi(path, method = 'GET', body = null) {
    return new Promise((resolve) => {
        const url = new URL(path, API_BASE);
        const rawBody = body ? JSON.stringify(body) : '';

        const headers = {};
        if (body) {
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = Buffer.byteLength(rawBody);
        }

        if (HMAC_SECRET && body) {
            const hmac = crypto.createHmac('sha256', HMAC_SECRET).update(rawBody).digest('hex');
            headers['x-remote-hmac'] = hmac;
        }

        const options = { method, headers };

        const req = http.request(url, options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    if (res.statusCode >= 400) {
                        resolve({ ok: false, error: `HTTP ${res.statusCode}: ${data}` });
                    } else {
                        resolve(JSON.parse(data));
                    }
                } catch (e) {
                    resolve({ ok: false, error: 'Failed to parse JSON response', raw: data });
                }
            });
        });

        req.on('error', (err) => {
            resolve({ ok: false, error: `Connection failed: ${err.message}. Is the Container Browser running with Export Server enabled?` });
        });

        if (body) req.write(rawBody);
        req.end();
    });
}

const tools = [
    {
        name: 'list_containers',
        description: 'List all available browser containers.',
        inputSchema: { type: 'object', properties: {} }
    },
    {
        name: 'navigate',
        description: 'Navigate a container to a URL.',
        inputSchema: {
            type: 'object',
            properties: {
                containerId: { type: 'string' },
                url: { type: 'string' },
                timeoutMs: { type: 'number' }
            },
            required: ['containerId', 'url']
        }
    },
    {
        name: 'get_html',
        description: 'Get HTML content of the active page.',
        inputSchema: {
            type: 'object',
            properties: {
                containerId: { type: 'string' },
                mode: { type: 'string', enum: ['trim', 'full', 'none'], default: 'trim' }
            },
            required: ['containerId']
        }
    },
    {
        name: 'click',
        description: 'Click an element.',
        inputSchema: {
            type: 'object',
            properties: {
                containerId: { type: 'string' },
                selector: { type: 'string', description: 'CSS selector or xpath:prefix' },
                waitForSelector: { type: 'string' }
            },
            required: ['containerId', 'selector']
        }
    },
    {
        name: 'type',
        description: 'Type text into an input field.',
        inputSchema: {
            type: 'object',
            properties: {
                containerId: { type: 'string' },
                selector: { type: 'string' },
                text: { type: 'string' }
            },
            required: ['containerId', 'selector', 'text']
        }
    },
    {
        name: 'click_and_type',
        description: 'Click an element and type a random character (used for focus checks).',
        inputSchema: {
            type: 'object',
            properties: {
                containerId: { type: 'string' },
                selector: { type: 'string' }
            },
            required: ['containerId', 'selector']
        }
    },
    {
        name: 'eval_js',
        description: 'Execute JavaScript in the page.',
        inputSchema: {
            type: 'object',
            properties: {
                containerId: { type: 'string' },
                script: { type: 'string' }
            },
            required: ['containerId', 'script']
        }
    },
    {
        name: 'screenshot',
        description: 'Take a screenshot of the page.',
        inputSchema: {
            type: 'object',
            properties: {
                containerId: { type: 'string' }
            },
            required: ['containerId']
        }
    }
];

const rl = readline.createInterface({
    input: process.stdin,
    terminal: false
});

rl.on('line', async (line) => {
    if (!line.trim()) return;
    try {
        const request = JSON.parse(line);
        const { method, params, id } = request;

        if (method === 'initialize') {
            sendResponse(id, {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'container-browser-mcp', version: '1.0.0' }
            });
        } else if (method === 'tools/list') {
            sendResponse(id, { tools });
        } else if (method === 'tools/call') {
            const { name, arguments: args } = params;
            try {
                const result = await handleToolCall(name, args);
                sendResponse(id, result);
            } catch (e) {
                sendResponse(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
            }
        }
    } catch (e) {
        // console.error(e);
    }
});

function sendResponse(id, result) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

async function handleToolCall(name, args) {
    const { containerId } = args;

    switch (name) {
        case 'list_containers':
            return wrapResult(await callApi('/internal/containers/list'));

        case 'navigate':
            return wrapResult(await callApi('/internal/exec', 'POST', {
                contextId: containerId,
                command: 'navigate',
                url: args.url,
                options: { timeoutMs: args.timeoutMs || 30000 }
            }));

        case 'get_html':
            return wrapResult(await callApi('/internal/exec', 'POST', {
                contextId: containerId,
                command: 'status',
                options: { returnHtml: args.mode || 'trim' }
            }));

        case 'click':
            return wrapResult(await callApi('/internal/exec', 'POST', {
                contextId: containerId,
                command: 'click',
                selector: args.selector,
                options: { waitForSelector: args.waitForSelector }
            }));

        case 'type':
            return wrapResult(await callApi('/internal/exec', 'POST', {
                contextId: containerId,
                command: 'type',
                selector: args.selector,
                text: args.text
            }));

        case 'click_and_type':
            return wrapResult(await callApi('/internal/exec', 'POST', {
                contextId: containerId,
                command: 'clickAndType',
                selector: args.selector
            }));

        case 'eval_js':
            return wrapResult(await callApi('/internal/exec', 'POST', {
                contextId: containerId,
                command: 'eval',
                eval: args.script
            }));

        case 'screenshot':
            return wrapResult(await callApi('/internal/exec', 'POST', {
                contextId: containerId,
                command: 'status',
                options: { screenshot: true }
            }));

        default:
            throw new Error(`Unknown tool: ${name}`);
    }
}

function wrapResult(res) {
    return {
        content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
        isError: !res.ok
    };
}
