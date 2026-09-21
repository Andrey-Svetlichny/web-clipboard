# note

An end-to-end encrypted web clipboard for sharing text between Computers, phones, etc.

Text only, one item at a time, 24-hour expiry. No account, no install, no extension: a
browser tab over 443 and nothing else, which is the point — some VM allows a browser and
not much else.

## Install

Host with a domain pointed at it, and Docker. Nothing else: the server has no
dependencies, and there is no build step.

### Important: in .env set NOTE_DOMAIN
```sh
docker compose up -d --build
```

Caddy obtains a TLS certificate on first request and renews it by itself.

Then open `https://<your domain>` on your PC, choose **Create a new code**, and save the
code in your password manager. On the work VM, open the same address, choose **I have a
code**, and type those twenty characters. That is the only place you ever type them.

## Documentation

- **[README_FULL.md](README_FULL.md)** — what it protects against and what it does not,
  day-to-day use, rotating and unlinking devices, deployment options, and development.
- **[spec.md](spec.md)** — the protocol. Read this before changing anything cryptographic.
