# deminimis-worker

Playwright-worker voor de De Minimis-module. Eén GitHub Actions-run of één HTTP-request kan maximaal 100 klanten in één container verwerken. De instelbare concurrency (standaard 3, maximaal 5) verwerkt meerdere klanten tegelijk zonder per klant een nieuwe runner te starten.

## GitHub Actions

De workflow verwacht één `batch_payload` input met gedeelde callbackinstellingen, `concurrency` en een `jobs`-array. De Grantly-module maakt deze payload automatisch aan. De workflow draait rechtstreeks op `ubuntu-latest`, zoals de snelle worker 1.0.0, en installeert daarna alleen Chromium met de vereiste systeemdependencies. Hierdoor hoeft GitHub Actions geen volledige Playwright-jobcontainer op te halen voordat de stappen kunnen starten.

## Cloud Run / HTTP

Stel altijd `WORKER_TOKEN` in. Zonder token weigert de server alle jobrequests.

Endpoint: `POST /jobs/deminimis`

```json
{
  "callback_url": "https://crm.example.com/deminimis/callback",
  "callback_token": "secret",
  "source_url": "https://aid-register.ec.europa.eu/de-minimis",
  "country": "Netherlands",
  "timeout_ms": 30000,
  "concurrency": 3,
  "jobs": [
    {
      "job_id": 1,
      "customer_id": 10,
      "kvk": "12345678",
      "company_name": "ACME BV"
    }
  ]
}
```

De oude enkelvoudige HTTP-payload blijft ondersteund. GitHub Actions gebruikt vanaf worker 1.1.0 uitsluitend de batchpayload.
