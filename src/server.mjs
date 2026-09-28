import express from 'express';
import crypto from 'crypto';
import { spawn } from 'node:child_process';

const app = express();
app.use(express.json({ limit: '5mb' }));

const port = process.env.PORT || 8080;
const workerToken = process.env.WORKER_TOKEN || '';

function bearerToken(req) {
  const match = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function validWorkerToken(providedToken) {
  const expected = Buffer.from(workerToken);
  const provided = Buffer.from(providedToken || '');
  return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
}

function runScraper(batch, job) {
  return new Promise((resolve, reject) => {
    const payload = {
      url: batch.source_url || 'https://aid-register.ec.europa.eu/de-minimis',
      kvk: job.kvk,
      companyName: job.company_name || '',
      country: batch.country || 'Netherlands',
      timeout: batch.timeout_ms || 30000,
      userAgent: batch.user_agent || 'Mozilla/5.0 (compatible; Grantly DeMinimis Sync/1.2)',
    };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
    const child = spawn(process.execPath, ['src/eair_fetch.mjs', encoded], {
      cwd: process.cwd(),
      env: process.env,
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || stdout || `Scraper exited with code ${code}`));
        return;
      }

      try {
        const parsed = JSON.parse(stdout.trim());
        if (!parsed.success) {
          reject(new Error(parsed.message || 'Scraper returned unsuccessful response.'));
          return;
        }
        resolve(parsed.records || []);
      } catch (error) {
        reject(new Error(`Invalid scraper output: ${stdout.slice(0, 1000)}`));
      }
    });
  });
}

async function postCallback(batch, body) {
  const response = await fetch(batch.callback_url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${batch.callback_token}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Callback failed with HTTP ${response.status}: ${text.slice(0, 1000)}`);
  }
}

function normalizeBatch(payload) {
  if (Array.isArray(payload.jobs)) {
    return payload;
  }

  return {
    callback_url: payload.callback_url,
    callback_token: payload.callback_token,
    source_url: payload.source_url,
    country: payload.country,
    timeout_ms: payload.timeout_ms,
    user_agent: payload.user_agent,
    jobs: [{
      job_id: payload.job_id,
      customer_id: payload.customer_id,
      kvk: payload.kvk,
      company_name: payload.company_name,
    }],
  };
}

async function processJob(batch, job) {
  await postCallback(batch, {
    job_id: job.job_id,
    customer_id: job.customer_id,
    status: 'running',
    message: 'Worker batch gestart.',
  });

  try {
    const records = await runScraper(batch, job);
    await postCallback(batch, {
      job_id: job.job_id,
      customer_id: job.customer_id,
      status: 'success',
      message: `${records.length} record(s) verwerkt.`,
      records,
    });
  } catch (error) {
    await postCallback(batch, {
      job_id: job.job_id,
      customer_id: job.customer_id,
      status: 'error',
      error_message: error.message || String(error),
      records: [],
    });
  }
}

app.get('/health', (req, res) => {
  res.json({ success: true, configured: workerToken !== '' });
});

app.post('/jobs/deminimis', async (req, res) => {
  if (!workerToken) {
    return res.status(503).json({ success: false, message: 'WORKER_TOKEN is not configured.' });
  }
  if (!validWorkerToken(bearerToken(req))) {
    return res.status(401).json({ success: false, message: 'Unauthorized worker request.' });
  }

  const batch = normalizeBatch(req.body || {});
  if (!batch.callback_url || !batch.callback_token || !Array.isArray(batch.jobs) || batch.jobs.length === 0 || batch.jobs.length > 100) {
    return res.status(400).json({ success: false, message: 'Invalid batch payload.' });
  }
  if (batch.jobs.some((job) => !job.job_id || !job.customer_id || !job.kvk)) {
    return res.status(400).json({ success: false, message: 'Every job requires job_id, customer_id and kvk.' });
  }

  const remoteJobId = crypto.randomUUID();
  res.status(202).json({
    success: true,
    accepted: true,
    remote_job_id: remoteJobId,
    batch_size: batch.jobs.length,
  });

  (async () => {
    for (const job of batch.jobs) {
      try {
        await processJob(batch, job);
      } catch (error) {
        console.error(`Worker job ${job.job_id} failed:`, error.message || String(error));
      }
    }
  })().catch((error) => {
    console.error('Detached worker batch failed:', error);
  });
});

app.listen(port, () => {
  console.log(`deminimis-worker listening on ${port}`);
});
