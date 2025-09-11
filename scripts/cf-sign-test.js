const { getSignedUrl } = require('aws-cloudfront-sign');
const fs = require('fs');

const keypairId = process.env.CF_KEYPAIR_ID || 'K1LGK3C9516OZR';
const keyPath   = process.env.CF_PRIVATE_KEY_PATH || 'cf_sign_priv.pem';
const url       = process.env.CF_TEST_URL || 'https://updates.threadsbooster.jp/latest.yml';

if (!fs.existsSync(keyPath)) {
  console.error('[ERROR] Private key file not found:', keyPath);
  process.exit(2);
}

const privateKey = fs.readFileSync(keyPath, 'utf8');
const expireTime = Date.now() + 10 * 60 * 1000; // 10分

const signedUrl = getSignedUrl(url, { keypairId, privateKeyString: privateKey, expireTime });
console.log(signedUrl);


