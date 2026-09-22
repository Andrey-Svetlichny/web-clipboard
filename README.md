# web-clipboard

An end-to-end encrypted web clipboard for sharing text between Computers, phones, etc.

One shared text, plus up to five attachments of 1 MiB each, 24-hour expiry. No account,
no install, no extension: a browser tab over 443 and nothing else, which is the point —
some VM allows a browser and not much else.

Attachments are encrypted in the browser like the text is: their names and types travel
inside the ciphertext, and the server only ever learns how many bytes a record holds.
Each file is its own record, so adding or removing one costs one file and the bytes are
fetched only when someone clicks the name. Files expire with the text — any write extends
the whole room, so an attachment never outlives the text that names it.

Raising the limits means changing three things together, or the largest file will 413 at
whichever one you forgot: `MAX_BODY`/`MAX_CT` in `server/index.mjs`, `client_max_body_size`
in `deploy/nginx-web-clipboard.conf`, and `max_size` in the `Caddyfile`. `MAX_FILES` and
`MAX_FILE_BYTES` in `web/index.html` are what the page itself enforces.

## Install

Host with a domain pointed at it, and Docker. Nothing else: the server has no
dependencies, and there is no build step.

On Ubuntu, `docker.io` alone is not enough — it ships neither compose nor buildx:

```sh
sudo apt-get install -y docker.io docker-compose-v2 docker-buildx
```

Copy the whole directory to `/opt/web-clipboard` on the server: compose resolves
`build: .` and the config mounts relative to it, so the files have to stay together.
`tests/` and `.git` are not needed at runtime.

### Important: in .env set CLIPBOARD_DOMAIN

Point an `A` record at the server first — TLS issuance fails until the name resolves.

### If nothing else uses port 443

Use Caddy, which obtains a TLS certificate on first request and renews it by itself.
Restore the `caddy` service in `docker-compose.yml` (it is in git history), then:

```sh
docker compose up -d --build
```

### Without Docker

The server has no dependencies, so systemd runs it directly. It needs Node >= 22.5 for
`node:sqlite`, which is newer than Ubuntu's `nodejs` package:

```sh
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
```

Then follow the header of `deploy/web-clipboard.service`. nginx is configured exactly as
below either way — both paths put the app on `127.0.0.1:8833`. That port is hardcoded in
two files, `deploy/web-clipboard.service` and `deploy/nginx-web-clipboard.conf`; change
it in both or nginx proxies into nothing.

### If the server already runs nginx

Caddy cannot share port 443, so let nginx terminate TLS and proxy to the app. This is
what `docker-compose.yml` is set up for as committed: it publishes the app on
`127.0.0.1:8833` and starts no Caddy. Inside the container the app still listens on 8080
— only the published host port has to match nginx.

```sh
docker compose up -d --build
sudo cp deploy/nginx-web-clipboard.conf /etc/nginx/sites-available/web-clipboard
sudo ln -s /etc/nginx/sites-available/web-clipboard /etc/nginx/sites-enabled/
# edit server_name in that file to your hostname
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d notes.example.com
```

Then open `https://<your domain>` on your PC, choose **Create a new code**, and save the
code in your password manager. On the work VM, open the same address, choose **I have a
code**, and type those twenty characters. That is the only place you ever type them.

## Documentation

- **[README_FULL.md](README_FULL.md)** — what it protects against and what it does not,
  day-to-day use, rotating and unlinking devices, deployment options, and development.
- **[spec.md](spec.md)** — the protocol. Read this before changing anything cryptographic.
