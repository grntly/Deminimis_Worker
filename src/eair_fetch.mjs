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
  userAgent = 'Mozilla/5.0 (compatible; Grantly DeMinimis Worker/1.2.1)'
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

async function ensureAccordionOpen(headerLocator) {
  await headerLocator.waitFor({ state: 'visible', timeout });
  const expanded = await headerLocator.getAttribute('aria-expanded').catch(() => null);
  if (expanded === 'true') {
    return;
  }
  await headerLocator.click();
  await headerLocator.page().waitForTimeout(800);
}

async function fillComboboxByLabel(page, labelText, value) {
  const label = page.getByText(labelText, { exact: true }).first();
  await label.waitFor({ state: 'visible', timeout });

  const container = label.locator('xpath=ancestor::div[1]');
  let input = container.locator(
    'xpath=following::input[not(@type="checkbox") and not(@type="radio") and not(@type="hidden")][1]'
  ).first();

  if (!(await input.count())) {
    input = page.locator(
      'input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]):not([disabled])'
    ).first();
  }

  await input.waitFor({ state: 'visible', timeout });
  await input.click();
  await input.fill('');
  await input.fill(value);
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
}

try {
  const page = await browser.newPage({ userAgent });
  page.setDefaultTimeout(timeout);

  await page.goto(url, { waitUntil: 'networkidle' });

  await page.waitForSelector('text=Country', { timeout });
  await page.waitForSelector('text=Beneficiary', { timeout });

  const countryHeader = page.getByText('Country', { exact: true }).first();
  await ensureAccordionOpen(countryHeader);
  await fillComboboxByLabel(page, 'Country', country);

  const beneficiaryHeader = page.getByText('Beneficiary', { exact: true }).first();
  await ensureAccordionOpen(beneficiaryHeader);

  const beneficiaryIdLabel = page.getByText('Beneficiary ID', { exact: true }).first();
  await beneficiaryIdLabel.waitFor({ state: 'visible', timeout });

  let beneficiaryIdInput = beneficiaryIdLabel.locator(
    'xpath=following::input[not(@type="checkbox") and not(@type="radio") and not(@type="hidden")][1]'
  ).first();

  if (!(await beneficiaryIdInput.count())) {
    beneficiaryIdInput = page.locator(
      'input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]):not([disabled])'
    ).last();
  }

  await beneficiaryIdInput.waitFor({ state: 'visible', timeout });
  await beneficiaryIdInput.click();
  await beneficiaryIdInput.fill(normalizeKvk(kvk));
  await page.waitForTimeout(500);

  await beneficiaryIdInput.waitFor({ state: 'visible', timeout });
  await beneficiaryIdInput.click();
  await beneficiaryIdInput.fill(normalizeKvk(kvk));
  await page.waitForTimeout(500);

  let searchButton = page.getByRole('button', { name: /search/i }).first();
  if (!(await searchButton.count())) {
    searchButton = page.locator('button').filter({ has: page.locator('svg') }).first();
  }

  await searchButton.click();

  await searchButton.click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1200);

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

  await page.waitForTimeout(1000);

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
