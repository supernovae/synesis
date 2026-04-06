const Fastify = require('fastify');
const { chromium } = require('playwright');

const app = Fastify({ logger: true });

app.post('/screenshot', async (request, reply) => {
  const { url, width = 1280, height = 800, delayMs = 1000 } = request.body;

  if (!url) {
    return reply.code(400).send({ error: 'URL is required' });
  }

  let browser;
  try {
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage({ viewport: { width, height } });
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForTimeout(delayMs);
    
    // Return screenshot as base64
    const buffer = await page.screenshot({ fullPage: true });
    const base64 = buffer.toString('base64');
    
    return { success: true, image_base64: base64 };
  } catch (err) {
    app.log.error(err);
    return reply.code(500).send({ error: 'Failed to take screenshot', details: err.message });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

app.get('/health', async () => ({ status: 'ok' }));

const start = async () => {
  try {
    await app.listen({ port: 8080, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();