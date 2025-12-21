#!/usr/bin/env node
/**
 * Test script for 'click' and 'clickAndType' commands
 * 
 * Usage:
 *   node test_click_and_type.js <containerId> <selector> [command]
 * 
 * Examples:
 *   node test_click_and_type.js my-container "input[type='text']" click
 *   node test_click_and_type.js my-container "input[type='text']" clickAndType
 */

const http = require('http');

function makeRequest(port, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: port,
      path: '/internal/exec',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(JSON.stringify(body))
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, body: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

async function test() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: node test_click_and_type.js <containerId> <selector> [command]');
    console.error('');
    console.error('Examples:');
    console.error('  node test_click_and_type.js container-123 "input[type=\'text\']" click');
    console.error('  node test_click_and_type.js container-123 "input[type=\'text\']" clickAndType');
    process.exit(1);
  }

  const containerId = args[0];
  const selector = args[1];
  const command = args[2] || 'clickAndType';
  const port = process.env.CONTAINER_EXPORT_PORT || 3001;

  console.log(`[test] Running '${command}' on selector: ${selector}`);
  console.log(`[test] Container ID: ${containerId}`);
  console.log(`[test] Port: ${port}`);
  console.log('');

  const payload = {
    contextId: containerId,
    command: command,
    selector: selector,
    options: {
      screenshot: false,
      returnHtml: 'none',
      returnCookies: false
    }
  };

  try {
    console.log('[test] Sending request...');
    console.log(`[test] Payload: ${JSON.stringify(payload, null, 2)}`);
    console.log('');

    const result = await makeRequest(port, payload);
    
    console.log(`[test] Response Status: ${result.status}`);
    console.log(`[test] Response Body:`);
    console.log(JSON.stringify(result.body, null, 2));
    
    if (result.body.ok) {
      console.log('');
      console.log('✅ Test PASSED');
      process.exit(0);
    } else {
      console.log('');
      console.log('❌ Test FAILED');
      process.exit(1);
    }
  } catch (e) {
    console.error('❌ Error:', e.message);
    process.exit(1);
  }
}

test();


