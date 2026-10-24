# Putting RunPad on the internet

This guide sets up RunPad as a public website with HTTPS, on a server you rent. It takes about 30 minutes, most of it waiting for the first build.

What you get:

- RunPad at `https://your-domain`, with a free certificate that renews itself (Caddy and Let's Encrypt).
- Visitors' programs run as a different temporary user each time, with no network access. They cannot read your pads' storage or each other's programs, and CPU, memory, disk and process limits apply.
- Limits per visitor (connections, saves, runs) and a total storage cap.
- An admin token for removing abuse, and a contact link on the home page.

## 1. What you need

- **A Linux server with a public IP address.** Any VPS works.
  - Size: 2 CPUs and 4 GB of memory serve a class or a small community; more CPUs let more programs run at the same time.
  - System: Ubuntu 24.04 is assumed below.
  - Cost: providers commonly charge around $5–15 a month for this size. Students can often use free cloud credit, for example through the GitHub Student Developer Pack or Azure for Students; check the current offers.
  - CPU type: RunPad works on both x86 and ARM servers.
- **A domain name**, for example `runpad.yourname.dev`. A free subdomain from a dynamic-DNS service also works.

## 2. Point the domain at the server

In your domain's DNS settings, add an **A record** for the name you want (for example `runpad`) with your server's IP address as the value. It can take a few minutes to take effect. Check with:

```bash
ping runpad.yourname.dev      # should show your server's IP
```

## 3. Prepare the server

Log in with SSH, then install Docker and open the web ports:

```bash
curl -fsSL https://get.docker.com | sudo sh

sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw allow 443/udp
sudo ufw enable
```

## 4. Get RunPad and configure it

```bash
git clone https://github.com/lakshmang007/claude.git
cd claude/runpad/deploy
cp .env.example .env
openssl rand -hex 24          # copy this: it becomes your admin token
nano .env
```

In `.env`, set at least:

- `DOMAIN`: your domain, for example `runpad.yourname.dev`.
- `RUNPAD_CONTACT`: an e-mail address (or web page) where people can report abuse.
- `RUNPAD_ADMIN_TOKEN`: the random value from `openssl rand -hex 24`. Keep it secret.

Optional:

- `RUNPAD_EXEC_TOKEN`: a run key. With one set, only people who know it can run code (for example, only your class).
- `RUNPAD_CPUS`, `RUNPAD_MEMORY`, `RUNPAD_MAX_CONCURRENT`: match these to your server's size.

If RunPad is still on a branch rather than `main`, add `-b <branch>` to the `git clone` command.

## 5. Start it

```bash
sudo docker compose up -d --build
```

The first build downloads the compilers and takes 10–15 minutes. Then check the log:

```bash
sudo docker compose logs runpad
```

You should see a line like:

```
Code execution: plain processes, network blocked by firewall, a user per run (20000-20999); languages: python, c, cpp, java, ...
```

Open `https://your-domain`. The first visit can take a few seconds while the certificate is issued.

## Everyday tasks

| Task | Command (run in `claude/runpad/deploy`) |
| --- | --- |
| See logs | `sudo docker compose logs -f runpad` |
| Restart | `sudo docker compose restart` |
| Update to the latest version | `git pull && sudo docker compose up -d --build` |
| Stop | `sudo docker compose down` (pads are kept) |
| Back up pads | `sudo docker run --rm -v deploy_runpad-data:/data -v "$PWD":/backup debian tar czf /backup/runpad-backup.tgz -C /data .` |
| Restore a backup | `sudo docker compose down && sudo docker run --rm -v deploy_runpad-data:/data -v "$PWD":/backup debian sh -c 'rm -rf /data/* && tar xzf /backup/runpad-backup.tgz -C /data' && sudo docker compose up -d` |

To remove an abusive pad, even a locked one, use your admin token:

```bash
curl -X POST https://your-domain/_api/delete \
  -H "X-Pad-Tokens: YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"path": "the/pad/path"}'
```

The same header lets you read a private pad (`curl -H "X-Pad-Tokens: …" https://your-domain/the/pad`) or remove a lock (`/_api/lock/remove`).

## Limits you can change

All of these go in `.env` (see the README for the full list).

| Setting | Default | What it controls |
| --- | --- | --- |
| `RUNPAD_MAX_CONCURRENT` | 6 | Programs running at the same time, across all visitors |
| `RUNPAD_MAX_PER_CLIENT` | 2 | Programs running at the same time for one visitor |
| `RUNPAD_RUNS_PER_MINUTE` | 40 | Runs per visitor per minute |
| `RUNPAD_CPU_SECONDS` | 10 | CPU time per program |
| `RUNPAD_RUN_TIMEOUT` / `RUNPAD_INTERACTIVE_TIMEOUT` | 15 / 300 | Seconds per run, without / with typed input |
| `RUNPAD_WORK_SIZE` | 1g | Memory for all programs' files together |
| `RUNPAD_MAX_STORAGE_MB` | 2048 | Text in all pads together; when full, pads can shrink but not grow |
| `RUNPAD_WRITES_PER_MINUTE` | 120 | Saves over HTTP per visitor per minute |
| `RUNPAD_MAX_SOCKETS_PER_IP` | 40 | Open editors and runs per visitor |
| `RUNPAD_TERMINAL` | on | `off` hides the terminal and keeps only Run |

Variables that are not listed under `environment:` in `docker-compose.yml` must be added there too, for example `RUNPAD_TERMINAL: ${RUNPAD_TERMINAL:-on}`.

## Troubleshooting

- **The browser says the certificate is invalid, or the site does not load.** The domain's A record may not point to the server yet, or ports 80 and 443 are blocked by the provider's firewall. Check `sudo docker compose logs caddy`.
- **`RunPad could not start: RUNPAD_FIREWALL=require …`.** RunPad refuses to start when it cannot cut programs off from the network. Make sure `cap_add` in `docker-compose.yml` still includes `NET_ADMIN`. Use a regular VPS; some container-only hosting does not allow firewall rules.
- **Programs fail with "Resource temporarily unavailable".** The server is out of processes or memory. Raise `RUNPAD_MEMORY`, or lower `RUNPAD_MAX_CONCURRENT`.
- **Go programs are slow the first time.** Each run gets its own build cache, so Go compiles its standard library again (a few seconds). This is the price of keeping runs apart.

## Running a public site

- **Your responsibility.** You are responsible for what people put on your site. Keep `RUNPAD_CONTACT` working, act on reports, and check the rules for hosting user content where you live.
- **What visitors should know.** Pads are public by default. The home page tells visitors not to store passwords or personal data in open pads.
- **Isolation strength.** The sandbox uses separate users, resource limits and a firewall: strong enough for a class or a community site, but the programs still share one Linux kernel. For a large public service, run the container under a stronger sandbox runtime such as gVisor. After switching, check that the startup log still says the network is blocked.
