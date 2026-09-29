import { spawn } from 'node:child_process';

const rawBatchPayload = process.env.BATCH_PAYLOAD || '';

function parseBatchPayload() {
  if (!rawBatchPayload) {
    throw new Error('Missing required env var: BATCH_PAYLOAD');
  }

  let payload;
  try {
    payload = JSON.parse(rawBatchPayload);
  } catch (error) {
    throw new Error(`BATCH_PAYLOAD is not valid JSON: ${error.message}`);
  }

  if (!payload.callback_url || !payload.callback_token || !Array.isArray(payload.jobs) || payload.jobs.length === 0) {
    throw new Error('Batch payload requires callback_url, callback_token and at least one job.');
  }

  if (payload.jobs.length > 100) {
    throw new Error('Batch payload cannot contain more than 100 jobs.');
  }

  if (payload.jobs.some((job) => !job.job_id || !job.customer_id || !job.kvk)) {
    throw new Error('Every job requires job_id, customer_id and kvk.');
  }

  return payload;
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
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Callback failed with HTTP ${response.status}: ${text.slice(0, 1000)}`);
  }
}

function runScraper(batch, job) {
  return new Promise((resolve, reject) => {
    const payload = {
      url: batch.source_url || 'https://aid-register.ec.europa.eu/de-minimis',
      kvk: job.kvk,
      companyName: job.company_name || '',
      country: batch.country || 'Netherlands',
      timeout: Number(batch.timeout_ms || 30000),
      userAgent: batch.user_agent || 'Mozilla/5.0 (compatible; Grantly DeMinimis Sync/1.2.4)',
    };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
    const processHandle = spawn(process.execPath, ['src/eair_fetch.mjs', encoded], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    processHandle.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    processHandle.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    processHandle.on('error', reject);
    processHandle.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `Scraper exited with code ${code}`));
        return;
      }

      try {
        const parsed = JSON.parse(stdout.trim());
        if (!parsed.success) {
          reject(new Error(parsed.message || 'Scraper returned an unsuccessful response.'));
          return;
        }
        resolve(parsed.records || []);
      } catch (error) {
        reject(new Error(`Invalid scraper JSON output: ${error.message}`));
      }
    });
  });
}

async function processJob(batch, job) {
  await postCallback(batch, {
    job_id: Number(job.job_id),
    customer_id: Number(job.customer_id),
    status: 'running',
    message: 'GitHub Actions batch scraper gestart.',
  });

  try {
    const records = await runScraper(batch, job);
    await postCallback(batch, {
      job_id: Number(job.job_id),
      customer_id: Number(job.customer_id),
      status: 'success',
      message: `${records.length} record(s) verwerkt.`,
      records,
    });
    return true;
  } catch (error) {
    await postCallback(batch, {
      job_id: Number(job.job_id),
      customer_id: Number(job.customer_id),
      status: 'error',
      error_message: error.message || String(error),
      records: [],
    });
    return false;
  }
}

async function main() {
  const batch = parseBatchPayload();
  let succeeded = 0;
  let failed = 0;

  console.log(`Starting one worker batch with ${batch.jobs.length} job(s).`);
  for (const job of batch.jobs) {
    try {
      if (await processJob(batch, job)) {
        succeeded += 1;
      } else {
        failed += 1;
      }
    } catch (error) {
      failed += 1;
      console.error(`Job ${job.job_id} could not be processed:`, error.message || String(error));
    }
  }

  console.log(`Batch complete. Succeeded: ${succeeded}; failed: ${failed}.`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('Batch dispatch failed:', error.message || String(error));
  process.exitCode = 1;
});
