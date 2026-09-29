#!/usr/bin/env node

import { chromium } from 'playwright';

function parseMoney(value) {
  if (!value) return 0;
  let cleaned = String(value)
    .replace(/[^\d,.\-]/g, '')
    .trim();

  if (cleaned.includes(',') && cleaned.includes('.')) {
    cleaned = cleaned.replace(/,/g, '');
  } else if (cleaned.includes(',') && !cleaned.includes('.')) {
    cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  }

  const num = parseFloat(cleaned);
  return Number.isFinite(num) ? num : 0;
}

function parseDate(value) {
  if (!value) return null;

  const v = String(value).trim();

  if (/^\d{2}\/\d{2}\/\d{4}$/.test(v)) {
    const [d, m, y] = v.split('/');
    return `${y}-${m}-${d}`;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    return v;
  }

  return null;
}

function afterLabel(text, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rx = new RegExp(`${escaped}\\s*(.+?)(?=(Reference number:|Beneficiary name:|Beneficiary ID:|Beneficiary type of ID:|Aid amount in EUR:|Sector of activity \\(NACE\\):|Aid instrument:|Granting authority name:|Granting date:|Published date:|$))`, 'i');
  const m = text.match(rx);
  return m ? m[1].trim() : '';
}

function normalizeKvk(value) {
  return String(value || '').replace(/\D+/g, '');
}

const encoded = process.argv[2];
if (!encoded) {
  console.log(JSON.stringify({ success: false, message: 'Missing payload argument.' }));
  process.exit(1);
}

const payload = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));

const {
  url,
  kvk,
  companyName = '',
  country = 'Netherlands',
  timeout = 30000,
  userAgent = 'Mozilla/5.0 (compatible; Grantly DeMinimis Sync/1.2.5)'
} = payload;

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage']
}).catch((err) => {
  console.log(JSON.stringify({
    success: false,
    message: `Browser launch failed: ${err.message}`
  }));
  process.exit(1);
});

try {
const page = await browser.newPage({ userAgent });
page.setDefaultTimeout(timeout);

await page.goto(url, { waitUntil: 'domcontentloaded' });

await page.waitForSelector('text=Country', { timeout });
await page.waitForSelector('text=Beneficiary', { timeout });

// Country accordion open
const countrySection = page.locator('text=Country').first();
await countrySection.click();
await page.waitForTimeout(800);

// zoek invulbaar inputveld binnen linker filterkolom
const sidebar = page.locator('text=Filters').locator('..').locator('..');

// pak eerste zichtbare invulbare input in filters
const countryInput = sidebar.locator(
  'input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]):not([disabled])'
).first();

await countryInput.waitFor({ state: 'visible', timeout });
await countryInput.click();
await countryInput.fill(country);
await page.keyboard.press('Enter');

await page.waitForTimeout(1000);

// Beneficiary accordion open
const beneficiaryHeader = page.locator('text=Beneficiary').first();
await beneficiaryHeader.click();
await page.waitForTimeout(800);

// Zoek het label "Beneficiary ID" en neem het eerstvolgende invulveld daaronder
const beneficiaryIdLabel = page.locator('text=Beneficiary ID').first();
await beneficiaryIdLabel.waitFor({ state: 'visible', timeout });

const beneficiaryBlock = beneficiaryIdLabel.locator('xpath=ancestor::div[contains(@class,"eui-u-mb") or contains(@class,"row")][1]');
let beneficiaryIdInput = beneficiaryBlock.locator(
  'input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]):not([disabled])'
).first();

// fallback als ancestor-structuur net anders is
if (!(await beneficiaryIdInput.count())) {
  beneficiaryIdInput = beneficiaryIdLabel.locator('xpath=following::input[not(@type="checkbox") and not(@type="radio") and not(@type="hidden")][1]');
}

await beneficiaryIdInput.waitFor({ state: 'visible', timeout });
await beneficiaryIdInput.click();
await beneficiaryIdInput.fill(normalizeKvk(kvk));

  let searchButton = page.getByRole('button', { name: /search/i }).first();

  if (!(await searchButton.count())) {
    searchButton = page.locator('button').filter({ has: page.locator('svg') }).first();
  }
  
  await searchButton.click();

  await page.waitForLoadState('networkidle', { timeout: Math.min(timeout, 12000) }).catch(() => {});

  // Expand alle resultaten die een expand knop hebben
  const expandButtons = page.locator('button[aria-expanded]');
  const btnCount = await expandButtons.count();
  for (let i = 0; i < btnCount; i++) {
    try {
      const expanded = await expandButtons.nth(i).getAttribute('aria-expanded');
      if (expanded === 'false') {
        await expandButtons.nth(i).click();
      }
    } catch (_) {}
  }

  await page.waitForTimeout(750);

  const records = await page.evaluate(() => {
    const textOf = (el) => (el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '');

    const afterLabelInBrowser = (text, label) => {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rx = new RegExp(
        `${escaped}\\s*(.+?)(?=(Reference number:|Beneficiary name:|Beneficiary ID:|Beneficiary type of ID:|Aid amount in EUR:|Sector of activity \\(NACE\\):|Aid instrument:|Granting authority name:|Granting date:|Published date:|$))`,
        'i'
      );
      const m = text.match(rx);
      return m ? m[1].trim() : '';
    };

    const toAbsoluteUrl = (href) => {
      try {
        return new URL(href, window.location.href).toString();
      } catch (_) {
        return '';
      }
    };

    const isGenericRegisterUrl = (href) => {
      try {
        const parsed = new URL(href, window.location.href);
        return parsed.hostname === 'aid-register.ec.europa.eu'
          && parsed.pathname.replace(/\/+$/, '') === '/de-minimis'
          && !parsed.search
          && !parsed.hash;
      } catch (_) {
        return true;
      }
    };

    const findAwardSourceUrl = (card, referenceNumber) => {
      const anchors = Array.from(card.querySelectorAll('a[href]'))
        .map((anchor) => {
          const href = toAbsoluteUrl(anchor.getAttribute('href'));
          const label = [
            textOf(anchor),
            anchor.getAttribute('aria-label') || '',
            anchor.getAttribute('title') || '',
            anchor.getAttribute('href') || ''
          ].join(' ');

          return {
            href,
            label
          };
        })
        .filter((candidate) => {
          if (!candidate.href) {
            return false;
          }

          if (/^(mailto|tel|javascript):/i.test(candidate.href)) {
            return false;
          }

          return true;
        });

      if (!anchors.length) {
        return window.location.href;
      }

      const scored = anchors
        .map((candidate, index) => {
          let score = 0;
          const haystack = `${candidate.href} ${candidate.label}`.toLowerCase();
          const reference = String(referenceNumber || '').toLowerCase();

          if (reference && haystack.includes(reference)) {
            score += 30;
          }

          if (/award|aid|de-minimis|detail|reference/.test(haystack)) {
            score += 8;
          }

          if (/beneficiar/.test(haystack)) {
            score -= 10;
          }

          if (/\.pdf($|\?)/i.test(candidate.href)) {
            score -= 5;
          }

          if (isGenericRegisterUrl(candidate.href)) {
            score -= 50;
          }

          score -= index;

          return {
            href: candidate.href,
            score
          };
        })
        .sort((a, b) => b.score - a.score);

      return scored[0] && scored[0].score > -50 ? scored[0].href : window.location.href;
    };

    const cards = Array.from(document.querySelectorAll('div,section,article,li'))
      .filter((el) => {
        const t = textOf(el);
        return t.includes('Aid amount') && t.includes('Granting date') && t.includes('Granting authority');
      });

    return cards.map((card) => {
      const text = textOf(card);
      const heading = card.querySelector('h1,h2,h3,h4,h5,strong,b');
      const referenceNumber = afterLabelInBrowser(text, 'Reference number:');

      return {
        heading: textOf(heading),
        fullText: text,
        sourceUrl: findAwardSourceUrl(card, referenceNumber)
      };
    });
  });

  const mapped = records.map((row) => {
    const text = row.fullText || '';
    let referenceNumber = afterLabel(text, 'Reference number:');
    let beneficiaryName = afterLabel(text, 'Beneficiary name:') || row.heading || companyName;
    let beneficiaryId = afterLabel(text, 'Beneficiary ID:') || kvk;
    let beneficiaryType = afterLabel(text, 'Beneficiary type of ID:') || 'Kvk nummer';
    let amountText = afterLabel(text, 'Aid amount in EUR:');
    let grantingDate = afterLabel(text, 'Granting date:');
    let authorityName = afterLabel(text, 'Granting authority name:') || afterLabel(text, 'Granting authority:');
    let sectorText = afterLabel(text, 'Sector of activity (NACE):');
    let aidInstrument = afterLabel(text, 'Aid instrument:');
    let publishedDate = afterLabel(text, 'Published date:');

    if (!referenceNumber) {
      referenceNumber = `DM-${normalizeKvk(beneficiaryId)}-${parseDate(grantingDate) || 'unknown'}-${parseMoney(amountText)}`;
    }

    let sectorCode = '';
    let sectorLabel = '';
    if (sectorText) {
      const parts = sectorText.split(' - ');
      sectorCode = (parts[0] || '').trim();
      sectorLabel = (parts.slice(1).join(' - ') || sectorText).trim();
    }

    return {
      reference_number: referenceNumber,
      award_type: /sgei/i.test(text) ? 'sgei' : (/agri/i.test(text) ? 'agri' : 'general'),
      beneficiary_name: beneficiaryName,
      beneficiary_identifier: normalizeKvk(beneficiaryId),
      beneficiary_identifier_type: /kvk/i.test(beneficiaryType) ? 'kvk' : beneficiaryType.toLowerCase(),
      authority_name: authorityName,
      country,
      aid_amount: parseMoney(amountText),
      aid_amount_eur: parseMoney(amountText),
      sector_nace_code: sectorCode,
      sector_nace_label: sectorLabel,
      aid_instrument: aidInstrument,
      granting_date: parseDate(grantingDate),
      published_date: parseDate(publishedDate),
      source_url: row.sourceUrl || url
    };
  }).filter((r) => r.beneficiary_identifier === normalizeKvk(kvk));

  console.log(JSON.stringify({
    success: true,
    records: mapped
  }));
} catch (error) {
  console.log(JSON.stringify({
    success: false,
    message: error.message || 'Unknown browser error'
  }));
  process.exit(1);
} finally {
  await browser.close();
}
