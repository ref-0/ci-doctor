# The guide's site

ci-doctor's guide on `https://ci-doctor.ref0.dev/guide/`, as static files: the repo's Markdown, and the files and folders it links to, at the paths they have in the repo. A relative link resolves on the site as it does in the repo, so a skills-only install can follow the hub's links out of `skills/` there. This is the repo's own build, not a reference implementation: the site doesn't serve this folder.

## Files

| File | What it does |
| --- | --- |
| `build.ts` | `node scripts/site/build.ts [<out>]`, default `dist/site/`. Node 24 and `git`, no install. The same commit builds the same bytes; build from a clean checkout, since it reads the working tree. |
| `cloudflare.config.ts`, `package.json` | The Worker `ci-doctor-guide` for `cf deploy`: static assets only, no code, and no domain of its own: the site's Worker, which holds `ci-doctor.ref0.dev`, serves it through a service binding. Only deploying needs them, after `npm install` here. |

## What it serves

| URL | From |
| --- | --- |
| `/llms.txt` | Generated: the guide's pages in `docs/README.md`'s order, the skills, the reference implementations' READMEs, the README and CHANGELOG, each with its frontmatter description or first sentence |
| `/guide/llms-full.txt` | Generated: the guide's pages whole, in that order |
| `/guide/<path>` | The repo's file at `<path>`: tracked Markdown in `docs/`, `skills/`, `templates/`, `scripts/`, `tools/`, `cache/` and `scorer/`, the README, CHANGELOG and LICENSE, and every tracked file a served Markdown file links to, or that sits in a folder one links to. Never tests' fixtures, `node_modules`, untracked files or this folder |
| `/guide/<folder>/` | Generated: an `index.html` listing the folder's served files, so a link to a folder resolves |

Markdown is served as `text/markdown`, folder listings as HTML, and everything else as plain UTF-8 text, so a `.ts` script reads as text (`_headers` in the build). The rest of `ci-doctor.ref0.dev`, such as `/` and `/<owner>/<repo>`, is the site's.

`node scripts/check.ts` builds into a temporary folder and fails when a relative link in a served Markdown file lands outside what's served, or `llms.txt` misses a guide page, skill or reference README, or names a file that isn't served.

## Try it locally

No Cloudflare sign-in is needed:

```sh
node scripts/site/build.ts
npx wrangler dev --assets dist/site
curl http://localhost:8787/llms.txt
```

## Deploy

Deploying publishes the guide, so do it from a release tag.

1. Check out the release tag, clean, and run `node scripts/site/build.ts`.
2. From this folder, `npm install`, then `cf deploy ../../dist/site`, signed in with `cf` to the account that holds the `ref0.dev` zone. It creates or updates the Worker `ci-doctor-guide`.
3. Check `https://ci-doctor.ref0.dev/llms.txt`, a guide page and a script, as under "Try it locally".
