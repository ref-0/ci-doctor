// --standing: the one thing that ever leaves the machine, and only when asked. It sends the score and the size
// class, as JSON with those two fields, and nothing else: no repo name, no account, no measurements.
import { CliError, usage } from './errors.ts';

/** ci-doctor.ref0.dev's endpoint, once the site has one. Until then a caller names it with --standing-url. */
export const STANDING_URL: string | undefined = undefined;

export interface Standing {
  score: number;
  size: string;
}

export const standingUrl = (flag: string | undefined, env = process.env.CI_DOCTOR_STANDING_URL) => {
  const named = flag ?? env ?? STANDING_URL;
  if (!named) throw usage("--standing has no endpoint yet: ci-doctor.ref0.dev doesn't take standings, so name one with --standing-url.");

  let url: URL;
  try {
    url = new URL(named);
  } catch {
    throw usage("--standing-url isn't a URL.");
  }
  // A query, fragment or sign-in in the URL would carry more than the two fields, or print a secret in an error.
  if (url.search || url.hash || url.username || url.password) throw usage('--standing-url takes no query, fragment or credentials: only the score and size are sent.');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw usage('--standing-url must be https (http only on this machine).');
  return url;
};

/** The request body: exactly these two fields, whatever else the report holds. */
export const standingBody = (s: Standing) => JSON.stringify({ score: s.score, size: s.size });

export const sendStanding = async (url: URL, s: Standing) => {
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: standingBody(s), redirect: 'error' });
  } catch (e) {
    throw new CliError(`Couldn't send the standing to ${url.origin}: ${(e as Error).message.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')}`);
  }
  if (!res.ok) throw new CliError(`The standing endpoint ${url.origin} answered ${res.status}.`);

  // It may answer { "standing": "Top 30% of small repos" }; that text is shown, without control characters.
  const text = await res.text();
  let said: unknown;
  try {
    said = (JSON.parse(text) as { standing?: unknown }).standing;
  } catch {
    said = undefined;
  }
  return typeof said === 'string' ? said.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, 300) : '';
};
