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
<<<<<<< Updated upstream
async function runScraper() {
  return await new Promise((resolve, reject) => {
=======

function runScraper(batch, job) {
  return new Promise((resolve, reject) => {
>>>>>>> Stashed changes
    const payload = {
      url: batch.source_url || 'https://aid-register.ec.europa.eu/de-minimis',
      kvk: job.kvk,
      companyName: job.company_name || '',
      country: batch.country || 'Netherlands',
      timeout: Number(batch.timeout_ms || 30000),
      userAgent: batch.user_agent || 'Mozilla/5.0 (compatible; Grantly DeMinimis Sync/1.2)',
    };
<<<<<<< Updated upstream

    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
    const args = ['src/eair_fetch.mjs', encoded];

    const proc = spawn('node', args, {
=======
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
    const processHandle = spawn(process.execPath, ['src/eair_fetch.mjs', encoded], {
>>>>>>> Stashed changes
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

<<<<<<< Updated upstream
    proc.on('error', reject);

    proc.on('close', (code) => {
      resolve({ code, stdout, stderr });
=======
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
>>>>>>> Stashed changes
    });
  });
}

async function processJob(batch, job) {
  if (!job.job_id || !job.customer_id || !job.kvk) {
    throw new Error('Job requires job_id, customer_id and kvk.');
  }

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
    });
    console.error(`Job ${job.job_id} failed:`, error.message || String(error));
    return false;
  }
}

async function main() {
<<<<<<< Updated upstream
  await postCallback({
    job_id: Number(jobId),
    customer_id: Number(customerId),
    status: 'running',
    message: 'GitHub Actions scraper gestart',
  });

  const result = await runScraper();

  if (result.code !== 0) {
    await postCallback({
      job_id: Number(jobId),
      customer_id: Number(customerId),
      status: 'error',
      error_message: result.stderr || `Scraper exited with code ${result.code}`,
      raw_output: (result.stdout || '').slice(0, 5000),
    });

    throw new Error(result.stderr || `Scraper exited with code ${result.code}`);
=======
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
      console.error(`Job ${job?.job_id || 'unknown'} could not be processed:`, error.message || String(error));
    }
>>>>>>> Stashed changes
  }

  console.log(`Batch complete. Succeeded: ${succeeded}; failed: ${failed}.`);
  if (failed > 0) {
    process.exitCode = 1;
  }
<<<<<<< Updated upstream

  await postCallback({
    job_id: Number(jobId),
    customer_id: Number(customerId),
    status: 'success',
    result: parsed,
  });
=======
>>>>>>> Stashed changes
}

main().catch((error) => {
  console.error('Batch dispatch failed:', error.message || String(error));
  process.exitCode = 1;
});
