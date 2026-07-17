const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const net = require('node:net');
const Fastify = require('fastify');
const { chromium } = require('playwright');

const blocked = new net.BlockList();
for (const [network, prefix, family] of [
  ['0.0.0.0', 8, 'ipv4'], ['10.0.0.0', 8, 'ipv4'], ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'], ['169.254.0.0', 16, 'ipv4'], ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'], ['192.0.2.0', 24, 'ipv4'], ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'], ['198.51.100.0', 24, 'ipv4'], ['203.0.113.0', 24, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'], ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'], ['::1', 128, 'ipv6'],
  ['fc00::', 7, 'ipv6'], ['fe80::', 10, 'ipv6'], ['ff00::', 8, 'ipv6'],
]) blocked.addSubnet(network, prefix, family);

function isAuthorized(header, token) {
  const supplied = header?.startsWith('Bearer ') ? header.slice(7) : '';
  const left = Buffer.from(supplied);
  const right = Buffer.from(token);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function validatePublicHttps(value, lookup = dns.lookup) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('URL must be valid public HTTPS');
  }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) {
    throw new Error('URL must be public HTTPS without credentials');
  }
  if (url.port && url.port !== '443') throw new Error('URL must use HTTPS port 443');
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address, family }) => {
    if (family === 6 && address.toLowerCase().startsWith('::ffff:')) {
      return blocked.check(address.slice(7), 'ipv4');
    }
    return blocked.check(address, family === 6 ? 'ipv6' : 'ipv4');
  })) {
    throw new Error('URL resolves to a blocked network');
  }
  url.hash = '';
  return url.toString();
}

function buildApp({ token, browserType = chromium } = {}) {
  if (!token) throw new Error('SYNESIS_VISION_WORKER_TOKEN is required');
  const app = Fastify({ logger: true, bodyLimit: 8192 });
  let activeRequests = 0;

  app.post('/screenshot', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['url'],
        properties: {
          url: { type: 'string', minLength: 1, maxLength: 2048 },
          width: { type: 'integer', minimum: 320, maximum: 3840, default: 1280 },
          height: { type: 'integer', minimum: 240, maximum: 2160, default: 800 },
          delayMs: { type: 'integer', minimum: 0, maximum: 10000, default: 1000 },
        },
      },
    },
    preHandler: async (request, reply) => {
      if (!isAuthorized(request.headers.authorization, token)) return reply.code(401).send({ error: 'Unauthorized' });
      if (activeRequests >= 1) return reply.code(429).send({ error: 'Worker is busy' });
      activeRequests += 1;
    },
  }, async (request, reply) => {
    const { width, height, delayMs } = request.body;
    let browser;
    try {
      const target = await validatePublicHttps(request.body.url);
      browser = await browserType.launch();
      const page = await browser.newPage({ viewport: { width, height } });
      await page.route('**/*', async (route) => {
        try {
          await validatePublicHttps(route.request().url());
          await route.continue();
        } catch {
          await route.abort('blockedbyclient');
        }
      });
      await page.goto(target, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(delayMs);
      const buffer = await page.screenshot({ fullPage: false, type: 'png' });
      return { success: true, image_base64: buffer.toString('base64') };
    } catch (err) {
      app.log.error(err);
      return reply.code(400).send({ error: 'Screenshot request rejected' });
    } finally {
      try {
        if (browser) await browser.close();
      } finally {
        activeRequests -= 1;
      }
    }
  });

  app.get('/health', async () => ({ status: 'ok' }));
  return app;
}

async function start() {
  const app = buildApp({ token: process.env.SYNESIS_VISION_WORKER_TOKEN });
  await app.listen({ port: Number(process.env.PORT || 8080), host: '0.0.0.0' });
}

if (require.main === module) start().catch((err) => { console.error(err); process.exit(1); });

module.exports = { buildApp, isAuthorized, validatePublicHttps };
