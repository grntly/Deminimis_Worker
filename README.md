# deminimis-worker

Playwright-worker voor de De Minimis-module. Eén GitHub Actions-run of één HTTP-request kan maximaal 100 klanten sequentieel verwerken. Daardoor worden browserdependencies en de runner/container slechts één keer per batch gestart.

## GitHub Actions

De workflow verwacht één `batch_payload` input met gedeelde callbackinstellingen en een `jobs`-array. De Grantly-module maakt deze payload automatisch aan.

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
