# web-clipboard

An end-to-end encrypted web clipboard for sharing text between computers, phones, etc.

One shared text, plus up to five attachments of 1 MiB each, 24-hour expiry. No account,
no install, no extension: a browser tab over 443 and nothing else, which is the point —
some VM allows a browser and not much else.

Attachments are encrypted in the browser like the text is: their names and types travel
inside the ciphertext, and the server only ever learns how many bytes a record holds.
Each file is its own record, so adding or removing one costs one file and the bytes are
fetched only when someone clicks the name. Files expire with the text — any write extends
the whole room, so an attachment never outlives the text that names it.

Raising the limits means changing them together, or the largest file will 413 at
whichever one you forgot: the 3 MiB request body (`MAX_BODY` in `server/index.mjs`,
`client_max_body_size` in `deploy/nginx-web-clipboard.conf`) and the 2 MiB ciphertext
(`MAX_CT` in `server/index.mjs`). `MAX_FILES` and `MAX_FILE_BYTES` in `web/api.js` are
what the page itself enforces.

## Install

A host with a domain pointed at it, nginx in front for TLS, and Docker. Nothing else: the
server has no dependencies, and there is no build step.

On Ubuntu, `docker.io` alone is not enough — it ships neither compose nor buildx:

```sh
sudo apt-get install -y docker.io docker-compose-v2 docker-buildx
```

Copy the whole directory to `/opt/web-clipboard` on the server: compose resolves
`build: .` relative to it, so the files have to stay together. `tests/` and `.git` are not
needed at runtime. To override a default such as `CLIPBOARD_TTL_SECONDS`, copy
`.env.example` to `.env` and edit it.

Point an `A` record at the server first — certbot cannot issue a certificate until the
name resolves.

### With Docker

`docker-compose.yml` publishes the app on `127.0.0.1:8833` only, for the host's nginx to
proxy to. Inside the container the app still listens on 8080 — only the published host
port has to match nginx.

```sh
docker compose up -d --build
sudo cp deploy/nginx-web-clipboard.conf /etc/nginx/sites-available/web-clipboard
sudo ln -s /etc/nginx/sites-available/web-clipboard /etc/nginx/sites-enabled/
# edit server_name in that file to your hostname
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d notes.example.com
```

### Without Docker

The server has no dependencies, so systemd runs it directly. It needs Node >= 22.13 for
`node:sqlite` without a flag, which is newer than Ubuntu's `nodejs` package:

```sh
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
```

An nvm-installed Node will not do here: nvm puts the binary under a user's
home directory and only adds it to `PATH` via shell rc files, which systemd
never sources. The unit also runs with `ProtectHome=yes`, which blocks
access to `/home` entirely. Use the system-wide install above so
`/usr/bin/node` actually exists.

Then follow the header of `deploy/web-clipboard.service`, and install nginx exactly as in
the Docker steps above — both paths put the app on `127.0.0.1:8833`. That port is
hard-coded in two files, `deploy/web-clipboard.service` and
`deploy/nginx-web-clipboard.conf`; change it in both or nginx proxies into nothing.

### Behind a proxy: TRUST_PROXY

The per-IP rate limit keys on the TCP peer unless `TRUST_PROXY=1`, in which case it takes
the first entry of `X-Forwarded-For`. Both committed setups set it, because the nginx
config overwrites that header with the real client address. Leave it unset on a server
that is exposed directly: there the header is whatever the client says.

### First use

Open `https://<your domain>` on your PC, choose **Create a new code**, and save the code
in your password manager. On the work VM, open the same address, choose **I have a
code**, and type those twenty characters. That is the only place you ever type them.

## Development

Node 22.13 or newer. Nothing to install, nothing to build.

```sh
npm run dev     # http://localhost:8080, restarts on edit
npm test
npm run smoke   # end-to-end, against a running npm run dev
```

See [README_FULL.md](README_FULL.md#developing) for the rest: why the page needs a
restart to change, why it only works on localhost or HTTPS, and when to regenerate the
test vectors.

## Documentation

- **[README_FULL.md](README_FULL.md)** — what it protects against and what it does not,
  day-to-day use, rotating and unlinking devices, deployment options, and development.
- **[spec.md](spec.md)** — the protocol. Read this before changing anything cryptographic.
